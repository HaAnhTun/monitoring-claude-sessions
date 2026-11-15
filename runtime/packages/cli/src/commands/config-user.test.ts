// `config get|set` (06 2.8): the whitelist of the user-facing keys, the effective value and its source, and the write through
// `opsConfig.configure`. The operations are fakes here (their own tests hold the validation, the atomic write and the audit
// trail); what is proven is what the commands add: the whitelist, the order of the calls, the wording of the result.
import type { ConfigureInput, ConfigureReport, InspectResult, OpContext } from '@mcs/engine';
import { McsError, type ConfigSource } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { USER_CONFIG_KEYS, getCommand, makeGetCommand, makeSetCommand, setCommand } from './config-user.ts';

function contextOf(positionals: readonly string[]): CommandContext {
  return {
    op: { repo: 'R' } as unknown as OpContext,
    args: {
      positionals,
      string: () => undefined,
      strings: () => [],
      flag: () => false,
      int: () => undefined,
    },
    scope: 'user',
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

interface Entry {
  readonly key: string;
  readonly value: unknown;
  readonly source: ConfigSource;
}

/** What the effective configuration of a fresh app holds for the user-facing keys. */
const FRESH: readonly Entry[] = [
  { key: 'app.name', value: 'Claude Agent Workspace', source: 'builtin' },
  { key: 'app.openAppWindow', value: false, source: 'builtin' },
  { key: 'backup.keep', value: 7, source: 'builtin' },
  { key: 'server.port', value: null, source: 'builtin' },
  { key: 'server.portScan', value: 19, source: 'builtin' },
  { key: 'terminal.args', value: [], source: 'builtin' },
  { key: 'terminal.command', value: 'claude', source: 'builtin' },
  { key: 'terminal.maxSessions', value: 8, source: 'builtin' },
];

function inspectOf(entries: readonly Entry[], effectivePort = 7690): () => Promise<InspectResult> {
  return () =>
    Promise.resolve({
      report: {},
      inspection: { entries: [...entries], files: [], effectivePort, engine: 'node' },
    } as unknown as InspectResult);
}

const CHANGED: ConfigureReport = { changed: true, changes: ['x'], unchanged: [], restart_needed: false };

describe('config keys', () => {
  it('are the seven user-facing keys of 06 2.8, nothing else', () => {
    expect([...USER_CONFIG_KEYS]).toEqual([
      'terminal.command',
      'terminal.args',
      'terminal.maxSessions',
      'app.name',
      'app.openAppWindow',
      'server.port',
      'server.portScan',
    ]);
  });

  it('names two commands of the app, with at most one and two arguments', () => {
    expect(getCommand.name).toBe('config get');
    expect(setCommand.name).toBe('config set');
    for (const cmd of [getCommand, setCommand]) {
      expect(cmd.defaultScope).toBe('user');
      expect(cmd.userOnly).toBe(true);
      expect(cmd.options).toEqual({});
    }
    expect(getCommand.positionals).toEqual({ max: 1 });
    expect(setCommand.positionals).toEqual({ max: 2 });
  });
});

describe('config get', () => {
  const never = (): never => {
    throw new Error('not called');
  };

  it('shows every whitelisted key in the order of the list, with the source, and nothing else of the configuration', async () => {
    const out = await makeGetCommand({ inspect: inspectOf(FRESH) }, () => Promise.resolve()).run(contextOf([]));
    expect(out.data).toEqual([
      { key: 'terminal.command', value: 'claude', source: 'default' },
      { key: 'terminal.args', value: [], source: 'default' },
      { key: 'terminal.maxSessions', value: 8, source: 'default' },
      { key: 'app.name', value: 'Claude Agent Workspace', source: 'default' },
      { key: 'app.openAppWindow', value: false, source: 'default' },
      { key: 'server.port', value: null, source: 'default' },
      { key: 'server.portScan', value: 19, source: 'default' },
    ]);
    expect(out.text).toEqual([
      'terminal.command = claude  (default)',
      'terminal.args = []  (default)',
      'terminal.maxSessions = 8  (default)',
      'app.name = Claude Agent Workspace  (default)',
      'app.openAppWindow = false  (default)',
      'server.port = null  (default; the first port tried is 7690)',
      'server.portScan = 19  (default)',
    ]);
  });

  it('shows one key, and the layer that produced it', async () => {
    const entries: Entry[] = FRESH.map((e) =>
      e.key === 'terminal.maxSessions' ? { ...e, value: 12, source: 'runtime' } : e,
    );
    const out = await makeGetCommand({ inspect: inspectOf(entries) }, () => Promise.resolve()).run(
      contextOf(['terminal.maxSessions']),
    );
    expect(out.data).toEqual([{ key: 'terminal.maxSessions', value: 12, source: 'runtime' }]);
    expect(out.text).toEqual(['terminal.maxSessions = 12  (runtime)']);
  });

  it('shows a list as JSON and a configured port without the note', async () => {
    const entries: Entry[] = FRESH.map((e) => {
      if (e.key === 'terminal.args') return { ...e, value: ['--model', 'opus'], source: 'runtime' };
      if (e.key === 'server.port') return { ...e, value: 7700, source: 'runtime' };
      return e;
    });
    const out = await makeGetCommand({ inspect: inspectOf(entries) }, () => Promise.resolve()).run(contextOf([]));
    expect(out.text).toContain('terminal.args = ["--model","opus"]  (runtime)');
    expect(out.text).toContain('server.port = 7700  (runtime)');
  });

  it('refuses a key outside the list before it touches anything, and names the list', async () => {
    const cmd = makeGetCommand({ inspect: never }, never);
    for (const key of ['logLevel', 'terminal.envKeep', 'backup.keep', '__proto__', 'terminal', '']) {
      await expect(cmd.run(contextOf([key]))).rejects.toMatchObject({ code: 'USAGE' });
    }
    const error = await cmd.run(contextOf(['logLevel'])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect((error as McsError).message).toContain('terminal.command');
    expect((error as McsError).message).toContain('server.portScan');
    expect((error as McsError).hint).toContain('caw configure --user');
  });

  it('makes the workspace of the app first, so a person can read the configuration before the first start', async () => {
    const calls: string[] = [];
    const cmd = makeGetCommand(
      {
        inspect: () => {
          calls.push('inspect');
          return inspectOf(FRESH)();
        },
      },
      () => {
        calls.push('ensure');
        return Promise.resolve();
      },
    );
    await cmd.run(contextOf([]));
    expect(calls).toEqual(['ensure', 'inspect']);
  });
});

describe('config set', () => {
  function fakes(report: ConfigureReport = CHANGED, after: readonly Entry[] = FRESH) {
    const calls: string[] = [];
    const inputs: ConfigureInput[] = [];
    const ops = {
      configure: (_ctx: OpContext, input: ConfigureInput) => {
        calls.push('configure');
        inputs.push(input);
        return Promise.resolve(report);
      },
      inspect: () => {
        calls.push('inspect');
        return inspectOf(after)();
      },
    };
    const ensure = (): Promise<void> => {
      calls.push('ensure');
      return Promise.resolve();
    };
    return { calls, inputs, ops: ops as Parameters<typeof makeSetCommand>[0], ensure };
  }

  it('writes through configure for the task user, with the reason, then reads the value back', async () => {
    const entries: Entry[] = FRESH.map((e) =>
      e.key === 'terminal.maxSessions' ? { ...e, value: 12, source: 'runtime' } : e,
    );
    const f = fakes(CHANGED, entries);
    const out = await makeSetCommand(f.ops, f.ensure).run(contextOf(['terminal.maxSessions', '12']));
    expect(f.calls).toEqual(['ensure', 'configure', 'inspect']);
    expect(f.inputs).toEqual([{ task: 'user', set: ['terminal.maxSessions=12'], reason: 'caw config set' }]);
    expect(out.text).toEqual(['saved terminal.maxSessions = 12']);
    expect(out.data).toEqual({
      key: 'terminal.maxSessions',
      value: 12,
      source: 'runtime',
      changed: true,
      restartNeeded: false,
    });
  });

  it('hands the value to configure as typed: JSON where it is JSON, the raw text where it is not', async () => {
    const f = fakes();
    const cmd = makeSetCommand(f.ops, f.ensure);
    await cmd.run(contextOf(['terminal.command', 'claude']));
    await cmd.run(contextOf(['terminal.args', '["--model","opus"]']));
    await cmd.run(contextOf(['app.openAppWindow', 'true']));
    await cmd.run(contextOf(['app.name', 'My = Workspace']));
    expect(f.inputs.map((i) => i.set)).toEqual([
      ['terminal.command=claude'],
      ['terminal.args=["--model","opus"]'],
      ['app.openAppWindow=true'],
      ['app.name=My = Workspace'],
    ]);
  });

  it('says restart needed when the app runs', async () => {
    const f = fakes({ ...CHANGED, restart_needed: true });
    const out = await makeSetCommand(f.ops, f.ensure).run(contextOf(['app.openAppWindow', 'true']));
    expect(out.text).toEqual([
      'saved app.openAppWindow = false',
      'restart needed: the running app keeps the old value until caw restart',
    ]);
    expect(out.data).toMatchObject({ restartNeeded: true });
  });

  it('says so when nothing changed, and does not ask for a restart', async () => {
    const f = fakes({ changed: false, changes: [], unchanged: [] });
    const out = await makeSetCommand(f.ops, f.ensure).run(contextOf(['terminal.maxSessions', '8']));
    expect(out.text).toEqual(['unchanged: terminal.maxSessions is already 8']);
    expect(out.data).toMatchObject({ changed: false, restartNeeded: false });
  });

  it('passes a rejection of the validation unchanged, and reads nothing back', async () => {
    const rejection = new McsError(
      'CONFIG_INVALID',
      'rejected, nothing written: runtime.json: terminal.maxSessions: too big',
    );
    const calls: string[] = [];
    const cmd = makeSetCommand(
      {
        configure: () => Promise.reject(rejection),
        inspect: () => {
          calls.push('inspect');
          return Promise.reject(new Error('not called'));
        },
      },
      () => Promise.resolve(),
    );
    await expect(cmd.run(contextOf(['terminal.maxSessions', '999']))).rejects.toBe(rejection);
    expect(calls).toEqual([]);
  });

  it('refuses a key outside the list, before the workspace is made and before anything is written', async () => {
    const f = fakes();
    const cmd = makeSetCommand(f.ops, f.ensure);
    for (const key of [
      'logLevel',
      'terminal.envKeep',
      'terminal.replayBytes',
      'schema_version',
      'constructor',
      'terminal.',
    ]) {
      await expect(cmd.run(contextOf([key, '1']))).rejects.toMatchObject({ code: 'USAGE' });
    }
    expect(f.calls).toEqual([]);
  });

  it('wants a key and a value', async () => {
    const f = fakes();
    const cmd = makeSetCommand(f.ops, f.ensure);
    await expect(cmd.run(contextOf([]))).rejects.toMatchObject({ code: 'USAGE' });
    await expect(cmd.run(contextOf(['terminal.command']))).rejects.toMatchObject({ code: 'USAGE' });
    expect(f.calls).toEqual([]);
  });

  it('does not repeat the value of a refused key in the message', async () => {
    const f = fakes();
    const error = await makeSetCommand(f.ops, f.ensure)
      .run(contextOf(['logLevel', 'a-secret-looking-value']))
      .catch((e: unknown) => e);
    expect((error as McsError).message).not.toContain('a-secret-looking-value');
    expect(String((error as McsError).hint)).not.toContain('a-secret-looking-value');
  });
});
