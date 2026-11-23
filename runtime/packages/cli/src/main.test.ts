// The kernel of the CLI (01 6.2): Ctrl+C ends a command with exit code 130 unless the command owns the signal itself
// (`interruptible: 'command'`, the way `serve` forwards it to the server). And the scope rule (06 2.2, ADR 0092): `--user`,
// the default scope of a command, the injected task, the note for people who still type `mcs`, the options of one scope only.
import os from 'node:os';
import path from 'node:path';

import { APP_CHECK_IDS, tasksRootOf, userRootOf } from '@mcs/engine';
import { CLI_NAME, McsError, PRODUCT_NAME, RUNTIME_VERSION } from '@mcs/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GLOBAL_OPTIONS,
  main,
  type CommandContext,
  type CommandDefinition,
  type CommandResult,
  type MainPaths,
} from './main.ts';
import { commandHelpLines, usageLine } from './render/text.ts';
import { APP_NOT_CREATED_HINT } from './scope.ts';

const probe = vi.hoisted(() => ({
  /** The SIGINT listeners that were added since the test started, as seen from inside each fake command. */
  inside: new Map<string, NodeJS.SignalsListener[]>(),
  baseline: [] as NodeJS.SignalsListener[],
  /** The contexts the scope fakes were run with, in order. */
  contexts: [] as CommandContext[],
  /** What `status` and `inspect` answer instead of their default: a result, or a failure (an engine error with its own hint). */
  answer: null as { result?: CommandResult; failure?: Error } | null,
  /** What the fake stream command saw after the reader of its output went away: the signal, and what `emit` answered. */
  afterClose: null as { aborted: boolean; emitted: boolean } | null,
}));

function listenersAddedSince(): NodeJS.SignalsListener[] {
  return process.listeners('SIGINT').filter((listener) => !probe.baseline.includes(listener));
}

vi.mock('./commands/serve.ts', () => ({
  command: {
    name: 'serve',
    summary: 'fake serve',
    synopsis: '',
    options: {},
    interruptible: 'command',
    run: () => {
      probe.inside.set('serve', listenersAddedSince());
      return Promise.resolve({ data: {}, text: [] });
    },
  } satisfies CommandDefinition,
}));

vi.mock('./commands/discover.ts', () => ({
  command: {
    name: 'discover',
    summary: 'fake discover',
    synopsis: '',
    options: {},
    run: () => {
      probe.inside.set('discover', listenersAddedSince());
      return Promise.resolve({ data: {}, text: [] });
    },
  } satisfies CommandDefinition,
}));

// A command of the lifecycle family: user scope by default, a required --task, options of one scope only, options that exclude
// each other.
vi.mock('./commands/status.ts', () => ({
  command: {
    name: 'status',
    summary: 'fake status',
    synopsis: '[--task SLUG]',
    defaultScope: 'user',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task' },
      force: { type: 'boolean', scope: 'user', description: 'for the app only' },
      only: { type: 'boolean', scope: 'task', description: 'for a task only' },
      window: { type: 'boolean', conflictsWith: ['tab'], description: 'a window' },
      tab: { type: 'boolean', description: 'a tab' },
    },
    run: (ctx) => {
      probe.contexts.push(ctx);
      if (probe.answer?.failure !== undefined) return Promise.reject(probe.answer.failure);
      return Promise.resolve(
        probe.answer?.result ?? {
          data: { scope: ctx.scope ?? null, task: ctx.args.string('task') ?? null },
          text: ['ran'],
        },
      );
    },
  } satisfies CommandDefinition,
}));

// A command that stays a task command: it has a --task option and no default scope.
vi.mock('./commands/inspect.ts', () => ({
  command: {
    name: 'inspect',
    summary: 'fake inspect',
    synopsis: '',
    options: { task: { type: 'string', valueName: 'SLUG', description: 'the task' } },
    run: (ctx) => {
      probe.contexts.push(ctx);
      if (probe.answer?.failure !== undefined) return Promise.reject(probe.answer.failure);
      return Promise.resolve({
        data: { scope: ctx.scope ?? null, task: ctx.args.string('task') ?? null },
        text: ['ran'],
      });
    },
  } satisfies CommandDefinition,
}));

// A command of the app only (open, autostart *, config get|set): it has no task option, so --task is an unknown option, and
// --repo and --root, which select a task, are refused by the kernel (06 2.2).
vi.mock('./commands/open.ts', () => ({
  command: {
    name: 'open',
    summary: 'fake open',
    synopsis: '',
    defaultScope: 'user',
    userOnly: true,
    options: { print: { type: 'boolean', description: 'print' } },
    run: (ctx) => {
      probe.contexts.push(ctx);
      return Promise.resolve({ data: { scope: ctx.scope ?? null }, text: ['ran'] });
    },
  } satisfies CommandDefinition,
}));

// A stream command (ADR 0108): it writes its lines through the kernel while it runs. `--follow` loses the reader of its output
// after the first line, `--since` fails after it.
vi.mock('./commands/events.ts', async () => {
  const { McsError } = await import('@mcs/shared');
  return {
    command: {
      name: 'events',
      summary: 'fake events',
      synopsis: '',
      defaultScope: 'user',
      stream: 'ndjson',
      options: {
        task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task' },
        follow: { type: 'boolean', description: 'lose the reader' },
        since: { type: 'string', description: 'fail' },
      },
      run: (ctx) => {
        ctx.emit?.('{"line":1}');
        if (ctx.args.string('since') !== undefined) {
          return Promise.reject(new McsError('API_ERROR', 'every live stream of the instance is taken'));
        }
        if (ctx.args.flag('follow')) {
          process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
          probe.afterClose = { aborted: ctx.signal?.aborted === true, emitted: ctx.emit?.('{"line":2}') === true };
        } else {
          ctx.emit?.('{"line":2}');
        }
        return Promise.resolve({ data: null, text: [] });
      },
    } satisfies CommandDefinition,
  };
});

// A command whose operation refuses because terminals are live (06 3.3), the way the guarded stop does.
vi.mock('./commands/restart.ts', async () => {
  const { McsError } = await import('@mcs/shared');
  return {
    command: {
      name: 'restart',
      summary: 'fake restart',
      synopsis: '',
      defaultScope: 'user',
      options: {},
      run: () =>
        Promise.reject(
          new McsError('TERMINALS_LIVE', '2 terminal sessions are live (api-1, web-1); restarting would end them', {
            hint: 'close them in the app, or run `caw restart --force` to end them now',
            details: { live: 2, sessions: ['api-1', 'web-1'] },
          }),
        ),
    } satisfies CommandDefinition,
  };
});

// The doctor: shows which checks the kernel wired in and what the app checks answer in the scope of the call.
vi.mock('./commands/doctor.ts', () => ({
  command: {
    name: 'doctor',
    summary: 'fake doctor',
    synopsis: '',
    defaultScope: 'user',
    options: { task: { type: 'string', valueName: 'SLUG', description: 'the task' } },
    run: async (ctx) => {
      probe.contexts.push(ctx);
      const providers = ctx.deps.extraChecks ?? {};
      const memory = providers['app.memory'];
      return {
        data: {
          ids: Object.keys(providers).sort(),
          memory: memory === undefined ? 'missing' : await memory(ctx.op, null),
        },
        text: [],
      };
    },
  } satisfies CommandDefinition,
}));

const PATHS: MainPaths = { launcherPath: 'launcher', skillDir: 'skill', runtimeDir: 'runtime' };

afterEach(() => {
  probe.inside.clear();
  probe.contexts.length = 0;
  probe.answer = null;
  probe.afterClose = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function begin(): void {
  probe.baseline = process.listeners('SIGINT');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

describe('main: who owns Ctrl+C', () => {
  it('registers the kernel listener for a command that does not say otherwise, and exits 130 on SIGINT', async () => {
    begin();
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    expect(await main(['discover', '--json'], PATHS)).toBe(0);
    const inside = probe.inside.get('discover') ?? [];
    expect(inside).toHaveLength(1);
    inside[0]?.('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
    expect(listenersAddedSince()).toEqual([]);
  });

  it("leaves SIGINT to a command that declares interruptible 'command'", async () => {
    begin();
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    expect(await main(['serve', '--json'], PATHS)).toBe(0);
    expect(probe.inside.get('serve')).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
    expect(listenersAddedSince()).toEqual([]);
  });

  it('does not touch the listeners that were there before the call', async () => {
    const other = (): void => undefined;
    process.on('SIGINT', other);
    try {
      begin();
      await main(['serve', '--json'], PATHS);
      expect(process.listeners('SIGINT')).toContain(other);
    } finally {
      process.off('SIGINT', other);
    }
  });
});

// ---- the scope rule (06 2.2, ADR 0092) -----------------------------------------------------------------------------------------

/** Nothing is created below it: the kernel only names the folders of the app. */
const HOME = path.join(os.tmpdir(), 'caw-main-test-home');
const REPO = path.join(os.tmpdir(), 'caw-main-test-repo');

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly lines: readonly string[];
}

async function run(argv: readonly string[], paths: MainPaths = PATHS): Promise<Ran> {
  vi.stubEnv('MCS_HOME', HOME);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(HOME, 'claude'));
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  const code = await main(argv, paths);
  const text = err.join('');
  return { code, out: out.join(''), err: text, lines: text.split('\n').filter((line) => line !== '') };
}

function dataOf(ran: Ran): Record<string, unknown> {
  const envelope: unknown = JSON.parse(ran.out);
  if (typeof envelope !== 'object' || envelope === null || !('data' in envelope)) throw new Error('no envelope');
  const data: unknown = envelope.data;
  if (typeof data !== 'object' || data === null) throw new Error('no data');
  return Object.fromEntries(Object.entries(data));
}

function warningsOf(ran: Ran): unknown {
  const envelope: unknown = JSON.parse(ran.out);
  return typeof envelope === 'object' && envelope !== null && 'warnings' in envelope ? envelope.warnings : null;
}

const NOTE = `without --task, --repo or --root this command now acts on the ${PRODUCT_NAME} app (before it acted on the task 'default'); pass --task default to keep the old behaviour`;

describe('main: the scope of a call', () => {
  it('--user selects the app: the context is the user root, and the task of the command is "user"', async () => {
    const ran = await run(['status', '--user', '--json']);
    expect(ran.code).toBe(0);
    const ctx = probe.contexts[0];
    expect(ctx?.scope).toBe('user');
    expect(ctx?.args.string('task')).toBe('user');
    expect(ctx?.op.root).toBe(userRootOf(process.env));
    expect(ctx?.op.repo).toBe(userRootOf(process.env));
    expect(dataOf(ran)).toEqual({ scope: 'user', task: 'user' });
  });

  it('a lifecycle command without a selector defaults to the app, and its required --task is satisfied', async () => {
    const ran = await run(['status', '--json']);
    expect(ran.code).toBe(0);
    expect(dataOf(ran)).toEqual({ scope: 'user', task: 'user' });
    expect(probe.contexts[0]?.op.root).toBe(userRootOf(process.env));
  });

  it('--task selects a task: nothing is injected, the root is the tasks root of the repository', async () => {
    const ran = await run(['status', '--task', 'demo', '--json']);
    expect(ran.code).toBe(0);
    expect(dataOf(ran)).toEqual({ scope: 'task', task: 'demo' });
    expect(probe.contexts[0]?.op.root).toBe(tasksRootOf(path.resolve('.')));
  });

  it('--repo and --root select a task too, so a required --task is still asked for', async () => {
    const byRepo = await run(['status', '--repo', REPO]);
    expect(byRepo.code).toBe(2);
    expect(byRepo.lines[0]).toBe('ERROR: status needs --task SLUG');
    const byRoot = await run(['status', '--root', path.join(REPO, 'tasks')]);
    expect(byRoot.code).toBe(2);
    expect(byRoot.lines[0]).toBe('ERROR: status needs --task SLUG');
    expect(probe.contexts).toEqual([]);
  });

  it('--repo with --task is a task call on that repository', async () => {
    const ran = await run(['status', '--repo', REPO, '--task', 'demo', '--json']);
    expect(ran.code).toBe(0);
    expect(probe.contexts[0]?.scope).toBe('task');
    expect(probe.contexts[0]?.op.root).toBe(tasksRootOf(REPO));
  });

  it('a command that is not in the lifecycle family stays a task command, and works on the app with --user', async () => {
    const task = await run(['inspect', '--json']);
    expect(dataOf(task)).toEqual({ scope: 'task', task: null });
    expect(probe.contexts[0]?.op.root).toBe(tasksRootOf(path.resolve('.')));
    const app = await run(['inspect', '--user', '--json']);
    expect(dataOf(app)).toEqual({ scope: 'user', task: 'user' });
    expect(probe.contexts[1]?.op.root).toBe(userRootOf(process.env));
  });

  it('--user with --task, --repo or --root is a usage error that names the three, with the usage line as the hint', async () => {
    for (const other of [
      ['--task', 'demo'],
      ['--repo', REPO],
      ['--root', REPO],
    ]) {
      const ran = await run(['status', '--user', ...other]);
      expect(ran.code).toBe(2);
      expect(ran.lines[0]).toBe('ERROR: --user cannot be combined with --task, --repo or --root');
      expect(ran.lines[1]).toMatch(/^hint: usage: .*status/);
    }
    expect(probe.contexts).toEqual([]);
  });

  it('the usage error of a conflict is an envelope with the code USAGE in --json mode', async () => {
    const ran = await run(['status', '--user', '--task', 'demo', '--json']);
    expect(ran.code).toBe(2);
    expect(JSON.parse(ran.out)).toMatchObject({ ok: false, exitCode: 2, error: { code: 'USAGE' } });
  });

  it('--help wins over a conflict: the person asked how to use the command', async () => {
    const ran = await run(['status', '--user', '--task', 'demo', '--help']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('--user');
  });
});

describe('main: the note for people who still type mcs', () => {
  const MCS: MainPaths = { ...PATHS, program: 'mcs' };
  const CAW: MainPaths = { ...PATHS, program: 'caw' };

  it('is one warning line when the program is mcs and the app was chosen by default', async () => {
    const ran = await run(['status'], MCS);
    expect(ran.code).toBe(0);
    expect(ran.lines).toEqual([`warning: ${NOTE}`]);
  });

  it('is part of the warnings of the envelope in --json mode, once', async () => {
    const ran = await run(['status', '--json'], MCS);
    expect(warningsOf(ran)).toEqual([NOTE]);
    expect(ran.err).toBe('');
  });

  it('is shown when no program is named (node dist/main.js is the mcs program)', async () => {
    const ran = await run(['status']);
    expect(ran.lines).toEqual([`warning: ${NOTE}`]);
  });

  it('is not shown for caw', async () => {
    const ran = await run(['status'], CAW);
    expect(ran.lines).toEqual([]);
    expect(warningsOf(await run(['status', '--json'], CAW))).toEqual([]);
  });

  it('is not shown when the person chose: --user, --task, --repo or --root', async () => {
    expect((await run(['status', '--user'], MCS)).lines).toEqual([]);
    expect((await run(['status', '--task', 'demo'], MCS)).lines).toEqual([]);
    expect((await run(['status', '--repo', REPO, '--task', 'demo'], MCS)).lines).toEqual([]);
  });

  it('is not shown for a command that defaults to a task', async () => {
    const ran = await run(['inspect'], MCS);
    expect(ran.code).toBe(0);
    expect(ran.lines).toEqual([]);
  });

  it('is not shown for --help, and not in front of an error', async () => {
    expect((await run(['status', '--help'], MCS)).lines).toEqual([]);
    const refused = await run(['restart'], MCS);
    expect(refused.code).toBe(3);
    expect(refused.lines.filter((line) => line.startsWith('warning:'))).toEqual([]);
  });
});

describe('main: options of one scope', () => {
  it('an option of the app is a usage error in a task call, and works on the app', async () => {
    const task = await run(['status', '--task', 'demo', '--force']);
    expect(task.code).toBe(2);
    expect(task.lines[0]).toBe('ERROR: --force applies to the app instance, not to a task');
    expect((await run(['status', '--force'])).code).toBe(0);
    expect((await run(['status', '--user', '--force'])).code).toBe(0);
  });

  it('an option of a task is a usage error in an app call, and works in a task call', async () => {
    const app = await run(['status', '--only']);
    expect(app.code).toBe(2);
    expect(app.lines[0]).toBe('ERROR: --only applies to a task (--task SLUG), not to the app instance');
    expect((await run(['status', '--task', 'demo', '--only'])).code).toBe(0);
  });

  it('options that exclude each other are a usage error', async () => {
    const ran = await run(['status', '--window', '--tab']);
    expect(ran.code).toBe(2);
    expect(ran.lines[0]).toBe('ERROR: --window cannot be combined with --tab');
    expect((await run(['status', '--window'])).code).toBe(0);
    expect((await run(['status', '--tab'])).code).toBe(0);
  });
});

describe('main: commands of the app only (06 2.3)', () => {
  it('runs in the scope of the app with no selector, and with --user', async () => {
    for (const argv of [
      ['open', '--json'],
      ['open', '--user', '--json'],
    ]) {
      const ran = await run(argv);
      expect(ran.code).toBe(0);
      expect(dataOf(ran)).toEqual({ scope: 'user' });
    }
    expect(probe.contexts.map((c) => c.op.root)).toEqual([userRootOf(process.env), userRootOf(process.env)]);
  });

  it('refuses --repo and --root, which would select a task, and names what it acts on', async () => {
    for (const other of [
      ['--repo', REPO],
      ['--root', REPO],
    ]) {
      const ran = await run(['open', ...other]);
      expect(ran.code).toBe(2);
      expect(ran.lines[0]).toBe(
        'ERROR: open acts on the app instance only; it cannot be combined with --repo or --root',
      );
      expect(ran.lines[1]).toMatch(/^hint: usage: .*open/);
    }
    expect(probe.contexts).toEqual([]);
  });

  it('refuses --task: the command has no such option', async () => {
    const ran = await run(['open', '--task', 'demo']);
    expect(ran.code).toBe(2);
    expect(ran.lines[0]).toMatch(/^ERROR: unknown option '--task'/);
    expect(probe.contexts).toEqual([]);
  });

  it('a refusal is an envelope with the code USAGE in --json mode', async () => {
    const ran = await run(['open', '--repo', REPO, '--json']);
    expect(ran.code).toBe(2);
    expect(JSON.parse(ran.out)).toMatchObject({ ok: false, exitCode: 2, error: { code: 'USAGE' } });
  });

  it('--help still works with a selector', async () => {
    const ran = await run(['open', '--repo', REPO, '--help']);
    expect(ran.code).toBe(0);
  });
});

describe('main: the registry of the commands of CAW-34', () => {
  it('lists open, the three autostart commands and config get and set next to config migrate, each once', async () => {
    const ran = await run(['help', '--json']);
    expect(ran.code).toBe(0);
    const names = JSON.stringify(dataOf(ran));
    for (const name of [
      'open',
      'autostart enable',
      'autostart disable',
      'autostart status',
      'config get',
      'config set',
      'config migrate',
    ]) {
      expect(names.split(JSON.stringify(name)).length - 1, name).toBeGreaterThanOrEqual(1);
    }
  });

  it('finds the commands by their words, the longest match first', async () => {
    for (const words of [
      ['autostart', 'status'],
      ['autostart', 'enable'],
      ['autostart', 'disable'],
      ['config', 'get'],
      ['config', 'set'],
    ]) {
      const ran = await run([...words, '--help']);
      expect(ran.code, words.join(' ')).toBe(0);
      expect(ran.out).toContain(CLI_NAME + ' ' + words.join(' '));
    }
  });

  it('has no task option and no positional arguments on the three autostart commands: an extra word is a usage error', async () => {
    const ran = await run(['autostart', 'status', 'now']);
    expect(ran.code).toBe(2);
    expect(ran.lines[0]).toBe("ERROR: unexpected argument 'now'");
  });

  it('config get takes at most one key and config set two words', async () => {
    const get = await run(['config', 'get', 'a', 'b']);
    expect(get.code).toBe(2);
    expect(get.lines[0]).toBe("ERROR: unexpected argument 'b'");
    const set = await run(['config', 'set', 'a', 'b', 'c']);
    expect(set.code).toBe(2);
    expect(set.lines[0]).toBe("ERROR: unexpected argument 'c'");
  });
});

describe('main: names and help', () => {
  it('lists --user among the common options, with what it does', async () => {
    expect(GLOBAL_OPTIONS['user']).toMatchObject({ type: 'boolean' });
    const ran = await run(['status', '--help']);
    expect(ran.out).toMatch(/--user\s+act on the .*app/);
    const json = await run(['status', '--help', '--json']);
    expect(JSON.stringify(dataOf(json))).toContain('"name":"user"');
  });

  it('marks the options of one scope in the help page', () => {
    const lines = commandHelpLines(
      {
        name: 'x',
        summary: 's',
        synopsis: '',
        options: {
          force: { type: 'boolean', scope: 'user', description: 'end them' },
          only: { type: 'boolean', scope: 'task', description: 'one task' },
          plain: { type: 'boolean', description: 'any' },
        },
        run: () => Promise.resolve({ data: null }),
      },
      GLOBAL_OPTIONS,
    );
    expect(lines.find((line) => line.includes('--force'))).toContain('(app instance only)');
    expect(lines.find((line) => line.includes('--only'))).toContain('(task only)');
    expect(lines.find((line) => line.includes('--plain'))).not.toContain('only)');
  });

  it('spells the command through CLI_NAME: the usage line, the hints and --version', async () => {
    const def: CommandDefinition = {
      name: 'x',
      summary: '',
      synopsis: '',
      options: {},
      run: () => Promise.resolve({ data: null }),
    };
    expect(usageLine(def)).toBe(`${CLI_NAME} x`);
    const version = await run(['--version']);
    expect(version.out).toBe(`${CLI_NAME} ${RUNTIME_VERSION}\n`);
    const unknown = await run(['nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.lines).toContain(`hint: run '${CLI_NAME} help' for the list of commands`);
    const usage = await run(['status', '--bogus']);
    expect(usage.lines[1]).toBe(`hint: usage: ${CLI_NAME} status [--task SLUG] (${CLI_NAME} help status)`);
  });
});

describe('main: a refusal because terminals are live', () => {
  it('exits 3 and prints the message and the hint of the operation', async () => {
    const ran = await run(['restart']);
    expect(ran.code).toBe(3);
    expect(ran.lines).toEqual([
      'ERROR: 2 terminal sessions are live (api-1, web-1); restarting would end them',
      'hint: close them in the app, or run `caw restart --force` to end them now',
    ]);
    expect(ran.out).toBe('');
  });

  it('is an envelope with the code TERMINALS_LIVE and the count and names in details in --json mode', async () => {
    const ran = await run(['restart', '--json']);
    expect(ran.code).toBe(3);
    expect(JSON.parse(ran.out)).toMatchObject({
      ok: false,
      exitCode: 3,
      error: { code: 'TERMINALS_LIVE', details: { live: 2, sessions: ['api-1', 'web-1'] } },
    });
  });
});

describe('main: the checks of the app in the doctor', () => {
  it('wires every app.* check next to the checks of the other areas', async () => {
    const ran = await run(['doctor', '--user', '--json']);
    const ids = dataOf(ran)['ids'];
    expect(ids).toEqual(expect.arrayContaining([...APP_CHECK_IDS, 'config.keys', 'hooks', 'workspace.format']));
  });

  it('answers in the app and says nothing in a task call', async () => {
    const app = await run(['doctor', '--user', '--json']);
    expect(dataOf(app)['memory']).toMatchObject({ id: 'app.memory', ok: false, level: 'warn' });
    const task = await run(['doctor', '--task', 'demo', '--json']);
    expect(dataOf(task)['memory']).toBeNull();
    const none = await run(['doctor', '--repo', REPO, '--json']);
    expect(dataOf(none)['memory']).toBeNull();
  });

  it('runs on the app when nothing selects a task', async () => {
    const ran = await run(['doctor', '--json']);
    expect(probe.contexts[0]?.scope).toBe('user');
    expect(dataOf(ran)['memory']).toMatchObject({ id: 'app.memory' });
  });
});

// The engine knows the app as the task `user`, so its hints say `mcs start --task user`. A call of the app never typed a task, and
// `--task user` would turn it into a task call that finds no task.json: the kernel words every text of an app call again.
describe('main: the wording of an app call', () => {
  /** A result the way the lifecycle operations of the engine word it for the instance `user`. */
  const ENGINE_RESULT: CommandResult = {
    data: {
      hint: 'run `mcs doctor --task user` or `mcs restart --task user`',
      message: ['hint: mcs start --task user'],
    },
    text: ['not running', 'hint: mcs start --task user'],
    warnings: ['the code changed: run `mcs restart --task user` (or `mcs upgrade --task user --restart`)'],
    exitCode: 1,
  };

  it('words the text lines and the warnings of a result', async () => {
    probe.answer = { result: ENGINE_RESULT };
    const ran = await run(['status', '--user']);
    expect(ran.code).toBe(1);
    expect(ran.out).toBe('not running\nhint: mcs start\n');
    expect(ran.lines).toEqual(['warning: the code changed: run `mcs restart` (or `mcs upgrade --user --restart`)']);
  });

  it('words the data and the warnings of the envelope, so a script reads the same hint', async () => {
    probe.answer = { result: ENGINE_RESULT };
    const ran = await run(['status', '--user', '--json']);
    expect(dataOf(ran)).toEqual({
      hint: 'run `mcs doctor` or `mcs restart`',
      message: ['hint: mcs start'],
    });
    expect(warningsOf(ran)).toEqual(['the code changed: run `mcs restart` (or `mcs upgrade --user --restart`)']);
  });

  it('words the message and the hint of an error, as text and as an envelope', async () => {
    probe.answer = {
      failure: new McsError('INSTANCE_NOT_RUNNING', 'no healthy monitor for this target', {
        hint: 'mcs start --task user',
      }),
    };
    const text = await run(['status']);
    expect(text.code).toBe(1);
    expect(text.lines).toEqual(['ERROR: no healthy monitor for this target', 'hint: mcs start']);
    const json = await run(['status', '--user', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: false,
      error: { code: 'INSTANCE_NOT_RUNNING', hint: 'mcs start' },
    });
  });

  it('a TASK_NOT_FOUND of a task command used with --user says to start the app once, not to init a task named user', async () => {
    probe.answer = {
      failure: new McsError('TASK_NOT_FOUND', 'no task.json in the folder of the app', {
        hint: 'mcs init --slug user',
      }),
    };
    const text = await run(['inspect', '--user']);
    expect(text.code).toBe(1);
    expect(text.lines).toEqual(['ERROR: no task.json in the folder of the app', `hint: ${APP_NOT_CREATED_HINT}`]);
    const json = await run(['inspect', '--user', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ error: { code: 'TASK_NOT_FOUND', hint: APP_NOT_CREATED_HINT } });
  });

  it('leaves a task call alone: its hints name its own task and its own commands', async () => {
    probe.answer = {
      failure: new McsError('TASK_NOT_FOUND', 'no task.json in the folder of demo', { hint: 'mcs init --slug demo' }),
    };
    const failed = await run(['inspect', '--task', 'demo']);
    expect(failed.lines).toEqual(['ERROR: no task.json in the folder of demo', 'hint: mcs init --slug demo']);
    probe.answer = { result: ENGINE_RESULT };
    const answered = await run(['status', '--task', 'demo']);
    expect(answered.out).toBe('not running\nhint: mcs start --task user\n');
  });

  it('leaves a usage error alone: it is raised before the scope is known and says how to type the command', async () => {
    const ran = await run(['status', '--user', '--task', 'demo']);
    expect(ran.code).toBe(2);
    expect(ran.lines[1]).toMatch(/^hint: usage: /);
  });
});

// ---- stream commands and the exit codes of a wait (ADR 0108) ---------------------------------------------------------------------

describe('main: a stream command', () => {
  it('prints its lines and no envelope, with --json and without', async () => {
    for (const argv of [['events', '--json'], ['events']]) {
      const ran = await run(argv);
      expect(ran.code).toBe(0);
      expect(ran.out).toBe('{"line":1}\n{"line":2}\n');
    }
  });

  it('ends a failure with one error envelope on one line', async () => {
    const ran = await run(['events', '--since', '5', '--json']);
    expect(ran.code).toBe(1);
    const lines = ran.out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('{"line":1}');
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      schema: 'mcs.cli/1',
      command: 'events',
      ok: false,
      exitCode: 1,
      error: { code: 'API_ERROR' },
    });
  });

  it('aborts the signal and writes nothing more once stdout fails (the reader of the pipe went away)', async () => {
    const ran = await run(['events', '--follow', '--json']);
    expect(ran.code).toBe(0);
    expect(ran.out).toBe('{"line":1}\n');
    expect(probe.afterClose).toEqual({ aborted: true, emitted: false });
  });
});

describe('main: the exit codes of a wait', () => {
  it('passes 4, 5 and 6 through, with the data and no error in the envelope', async () => {
    for (const exitCode of [4, 5, 6] as const) {
      probe.answer = { result: { data: { outcome: 'x' }, text: ['not met'], exitCode } };
      const text = await run(['status', '--user']);
      expect(text.code).toBe(exitCode);
      expect(text.out).toBe('not met\n');
      const json = await run(['status', '--user', '--json']);
      expect(json.code).toBe(exitCode);
      expect(JSON.parse(json.out)).toMatchObject({ ok: false, exitCode, error: null, data: { outcome: 'x' } });
    }
  });
});
