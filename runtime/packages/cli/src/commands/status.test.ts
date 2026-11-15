// `status` (01 6.3, 4.10; 06 2.3): the legacy JSON with the new keys for a task, exit 0 iff running; for the app the text lines of
// 06 2.3 (or the envelope with `UserStatusReport`), exit 0 iff it runs.
import type { OpContext, StatusReport, StatusResult, UserStatusReport, UserStatusResult } from '@mcs/engine';
import { PRODUCT_NAME } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand, uptimeText, userStatusLines } from './status.ts';

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

const STOPPED: StatusReport = {
  running: false,
  state_file: 'S',
  engine: null,
  probe: 'stopped',
  instance_id: 'I',
};

describe('status command', () => {
  it('takes --task only, and looks at the app when nothing selects a task', () => {
    expect(command.name).toBe('status');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual(['task']);
    expect(command.options['task']?.required).not.toBe(true);
  });

  it('prints the report as the legacy JSON and as the data of the envelope, exit 1 when it is not running', async () => {
    const result: StatusResult = { report: STOPPED, exitCode: 1 };
    const cmd = makeCommand({ status: () => Promise.resolve(result) });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(out.legacy).toEqual(STOPPED);
    expect(out.data).toEqual(STOPPED);
    expect(out.exitCode).toBe(1);
    expect(out.text).toBeUndefined();
  });

  it('exit 0 for a running instance', async () => {
    const running: StatusReport = { ...STOPPED, running: true, probe: 'running', engine: 'node' };
    const cmd = makeCommand({ status: () => Promise.resolve({ report: running, exitCode: 0 }) });
    expect((await cmd.run(contextOf({}))).exitCode).toBe(0);
  });

  it('an unmanaged-running workspace is printed like any report: engine null, exit 1', async () => {
    const unmanaged: StatusReport = {
      ...STOPPED,
      url: 'http://127.0.0.1:18000',
      pid: 7,
      engine: null,
      probe: 'unmanaged-running',
    };
    const cmd = makeCommand({ status: () => Promise.resolve({ report: unmanaged, exitCode: 1 }) });
    const out = await cmd.run(contextOf({}));
    expect(out.legacy).toEqual(unmanaged);
    expect(out.data).toEqual(unmanaged);
    expect(out.exitCode).toBe(1);
  });
});

describe('status command: a task call', () => {
  it('asks the task operation with the task, and never the app', async () => {
    const seen: unknown[] = [];
    const cmd = makeCommand(
      {
        status: (_ctx, input) => {
          seen.push(input);
          return Promise.resolve({ report: STOPPED, exitCode: 1 });
        },
      },
      {
        statusUser: () => {
          throw new Error('a call in task scope reached the app operation');
        },
      },
    );
    const out = await cmd.run(contextOf({ task: 'demo' }, 'task'));
    expect(seen).toEqual([{ task: 'demo' }]);
    expect(out.legacy).toEqual(STOPPED);
  });
});

// ---- the app ----------------------------------------------------------------------------------------------------------------------

const APP_RUNNING: UserStatusReport = {
  running: true,
  state_file: 'F/state.json',
  url: 'http://127.0.0.1:7690',
  pid: 18244,
  uptime_s: 7380,
  outdated: false,
  engine: 'node',
  probe: 'running',
  instance_id: 'I',
  runtime_version: '4.1.0',
  scope: 'user',
  configured_port: 7690,
  port_note: null,
  terminals: { live: 2, max: 8 },
  autostart: 'off',
  home: 'F',
  logs_dir: 'F/logs',
};

const APP_NEVER_STARTED: UserStatusReport = {
  running: false,
  state_file: 'F/state.json',
  hint: 'never started: run `caw start`',
  engine: null,
  probe: 'stopped',
  instance_id: null,
  scope: 'user',
  configured_port: 7690,
  port_note: null,
  terminals: null,
  autostart: 'off',
  home: 'F',
  logs_dir: 'F/logs',
};

function userOps(report: UserStatusReport, exitCode: 0 | 1, warnings: readonly string[] = []) {
  const result: UserStatusResult = { report, exitCode, warnings };
  return { statusUser: () => Promise.resolve(result) };
}

function neverTask(): never {
  throw new Error('a call in the scope of the app reached the task operation');
}

describe('uptimeText', () => {
  it('says seconds, minutes, hours and days, and leaves out a zero part', () => {
    expect(uptimeText(5)).toBe('5 s');
    expect(uptimeText(59)).toBe('59 s');
    expect(uptimeText(60)).toBe('1 min');
    expect(uptimeText(3599)).toBe('59 min');
    expect(uptimeText(3600)).toBe('1 h');
    expect(uptimeText(7380)).toBe('2 h 3 min');
    expect(uptimeText(86_400)).toBe('1 d');
    expect(uptimeText(90_000)).toBe('1 d 1 h');
  });

  it('rounds down and clamps what is not a count of seconds', () => {
    expect(uptimeText(59.9)).toBe('59 s');
    expect(uptimeText(-3)).toBe('0 s');
    expect(uptimeText(Number.NaN)).toBe('0 s');
  });
});

describe('userStatusLines: the text of 06 2.3', () => {
  it('a running app: the name and the version, the address, the pid and uptime, the terminals, the folders', () => {
    expect(userStatusLines(APP_RUNNING)).toEqual([
      `${PRODUCT_NAME} 4.1.0: running`,
      '  url:        http://127.0.0.1:7690/',
      '  pid:        18244 (up 2 h 3 min)',
      '  terminals:  2 live (max 8)',
      '  outdated:   no',
      '  autostart:  off',
      '  folder:     F',
      '  logs:       F/logs',
    ]);
  });

  it('a busy configured port is said next to the address', () => {
    const lines = userStatusLines({
      ...APP_RUNNING,
      url: 'http://127.0.0.1:7691',
      port_note: '7690 was busy; using 7691',
    });
    expect(lines.slice(0, 3)).toEqual([
      `${PRODUCT_NAME} 4.1.0: running`,
      '  url:        http://127.0.0.1:7691/',
      '  port:       7690 was busy; using 7691',
    ]);
  });

  it('an outdated app says what to do, and an app that cannot be counted says so', () => {
    const lines = userStatusLines({ ...APP_RUNNING, outdated: true, terminals: null, autostart: 'on' });
    expect(lines).toContain('  outdated:   yes (run `caw restart`)');
    expect(lines).toContain('  terminals:  unknown');
    expect(lines).toContain('  autostart:  on');
  });

  it('a single terminal and an unsupported autostart', () => {
    const lines = userStatusLines({ ...APP_RUNNING, terminals: { live: 1, max: 8 }, autostart: 'unsupported' });
    expect(lines).toContain('  terminals:  1 live (max 8)');
    expect(lines).toContain('  autostart:  unsupported');
  });

  it('a running app without a version or an uptime leaves them out', () => {
    const bare: UserStatusReport = {
      running: true,
      state_file: 'F/state.json',
      url: 'http://127.0.0.1:7690',
      pid: 18244,
      engine: 'node',
      probe: 'running',
      instance_id: 'I',
      scope: 'user',
      configured_port: 7690,
      port_note: null,
      terminals: { live: 2, max: 8 },
      autostart: 'off',
      home: 'F',
      logs_dir: 'F/logs',
    };
    const lines = userStatusLines(bare);
    expect(lines[0]).toBe(`${PRODUCT_NAME}: running`);
    expect(lines).toContain('  pid:        18244');
  });

  it('an app that was never started: not running, the hint, no address and no terminals', () => {
    expect(userStatusLines(APP_NEVER_STARTED)).toEqual([
      `${PRODUCT_NAME}: not running`,
      '  hint:       never started: run `caw start`',
      '  autostart:  off',
      '  folder:     F',
      '  logs:       F/logs',
    ]);
  });

  it('a state that is not "stopped" is named, and the hint of the operation is shown as it is (the kernel words it for the app)', () => {
    const lines = userStatusLines({
      ...APP_NEVER_STARTED,
      probe: 'unhealthy',
      url: 'http://127.0.0.1:7690',
      pid: 7,
      hint: 'runtime 7 answers its control channel but not HTTP; run `mcs doctor` or `mcs restart`',
    });
    expect(lines[0]).toBe(`${PRODUCT_NAME}: not running (unhealthy)`);
    expect(lines).toContain(
      '  hint:       runtime 7 answers its control channel but not HTTP; run `mcs doctor` or `mcs restart`',
    );
    expect(lines).toContain('  pid:        7');
    expect(lines).toContain('  url:        http://127.0.0.1:7690/');
  });

  it('a running app shows no hint (the outdated line says what to do)', () => {
    const lines = userStatusLines({ ...APP_RUNNING, outdated: true, hint: 'mcs restart' });
    expect(lines.some((line) => line.includes('hint:'))).toBe(false);
  });

  it('prints an address it cannot read as it is', () => {
    expect(userStatusLines({ ...APP_RUNNING, url: 'not an address' })).toContain('  url:        not an address');
  });
});

describe('status command: the app', () => {
  it('prints the lines, the report as data, no legacy JSON, exit 0 when it runs', async () => {
    const out = await makeCommand({ status: neverTask }, userOps(APP_RUNNING, 0)).run(
      contextOf({ task: 'user' }, 'user'),
    );
    expect(out.text).toEqual(userStatusLines(APP_RUNNING));
    expect(out.data).toEqual(APP_RUNNING);
    expect(out.legacy).toBeUndefined();
    expect(out.exitCode).toBe(0);
  });

  it('an app that is not running is exit 1 with the lines of a stopped app', async () => {
    const out = await makeCommand({ status: neverTask }, userOps(APP_NEVER_STARTED, 1)).run(contextOf({}, 'user'));
    expect(out.text).toEqual(userStatusLines(APP_NEVER_STARTED));
    expect(out.data).toMatchObject({ scope: 'user', running: false });
    expect(out.exitCode).toBe(1);
  });

  it('carries the warnings of the operation (a stale autostart shortcut)', async () => {
    const out = await makeCommand(
      { status: neverTask },
      userOps(APP_RUNNING, 0, ['the shortcut points elsewhere']),
    ).run(contextOf({}, 'user'));
    expect(out.warnings).toEqual(['the shortcut points elsewhere']);
  });

  it('shows no access code or token: the report has no field for one', async () => {
    const out = await makeCommand({ status: neverTask }, userOps(APP_RUNNING, 0)).run(contextOf({}, 'user'));
    expect(JSON.stringify(out)).not.toMatch(/#code=|token/);
  });
});
