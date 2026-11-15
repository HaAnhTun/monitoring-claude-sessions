// The scope rule of the CLI (06 2.2, ADR 0092): `--user` selects the app instance, `--task`, `--repo` or `--root` select the task
// world, and a command without any of them uses its default scope. `resolveScope` is pure (no process, no file system); the last block
// reads the command modules to pin which commands default to the app.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { McsError, cliExitCode, type CliError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  APP_NOT_CREATED_HINT,
  appCommandText,
  appErrorOf,
  inAppScope,
  resolveScope,
  type Scope,
  type ScopeSelectors,
} from './scope.ts';

type Default = Scope | undefined;

const DEFAULTS: readonly Default[] = [undefined, 'user', 'task'];

/** Every combination of the four selectors: bit 0 user, bit 1 task, bit 2 repo, bit 3 root. */
function combinations(): { readonly label: string; readonly values: ScopeSelectors }[] {
  const out: { label: string; values: ScopeSelectors }[] = [];
  for (let bits = 0; bits < 16; bits += 1) {
    const names = ['user', 'task', 'repo', 'root'].filter((_, i) => (bits & (1 << i)) !== 0);
    out.push({
      label: names.length === 0 ? 'no selector' : names.map((n) => `--${n}`).join(' '),
      values: {
        user: (bits & 1) !== 0,
        ...((bits & 2) !== 0 ? { task: 'demo' } : {}),
        ...((bits & 4) !== 0 ? { repo: 'R' } : {}),
        ...((bits & 8) !== 0 ? { root: 'T' } : {}),
      },
    });
  }
  return out;
}

function defOf(defaultScope: Default): { readonly defaultScope?: Scope } {
  return defaultScope === undefined ? {} : { defaultScope };
}

/** The McsError that `fn` throws; fails the test when it throws nothing or something else. */
function thrownBy(fn: () => unknown): McsError {
  try {
    fn();
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('the call did not throw');
}

describe('resolveScope: every selector combination under every default', () => {
  for (const defaultScope of DEFAULTS) {
    describe(`default scope ${defaultScope ?? '(none)'}`, () => {
      for (const { label, values } of combinations()) {
        const taskish = values.task !== undefined || values.repo !== undefined || values.root !== undefined;
        if (values.user && taskish) {
          it(`${label}: a usage error`, () => {
            const error = thrownBy(() => resolveScope(defOf(defaultScope), values));
            expect(error.code).toBe('USAGE');
            expect(cliExitCode(error.code)).toBe(2);
            expect(error.message).toBe('--user cannot be combined with --task, --repo or --root');
          });
        } else if (values.user) {
          it(`${label}: the app, chosen on purpose`, () => {
            expect(resolveScope(defOf(defaultScope), values)).toEqual({ scope: 'user', defaulted: false });
          });
        } else if (taskish) {
          it(`${label}: a task, chosen on purpose`, () => {
            expect(resolveScope(defOf(defaultScope), values)).toEqual({ scope: 'task', defaulted: false });
          });
        } else {
          const expected: Scope = defaultScope ?? 'task';
          it(`${label}: the default (${expected}), marked as defaulted`, () => {
            expect(resolveScope(defOf(defaultScope), values)).toEqual({ scope: expected, defaulted: true });
          });
        }
      }
    });
  }
});

describe('resolveScope: details', () => {
  it('a command without a default scope is a task command', () => {
    expect(resolveScope({}, { user: false })).toEqual({ scope: 'task', defaulted: true });
  });

  it('an empty value still counts as given (the person typed the option)', () => {
    expect(resolveScope({ defaultScope: 'user' }, { user: false, task: '' })).toEqual({
      scope: 'task',
      defaulted: false,
    });
    expect(resolveScope({ defaultScope: 'user' }, { user: false, repo: '' })).toEqual({
      scope: 'task',
      defaulted: false,
    });
    expect(thrownBy(() => resolveScope({}, { user: true, root: '' })).code).toBe('USAGE');
  });

  it('an undefined value is not given', () => {
    const values: ScopeSelectors = { user: false, task: undefined, repo: undefined, root: undefined };
    expect(resolveScope({ defaultScope: 'user' }, values)).toEqual({ scope: 'user', defaulted: true });
  });

  it('puts the hint of the caller on the usage error, and none when the caller gives none', () => {
    expect(thrownBy(() => resolveScope({}, { user: true, task: 'a' }, 'usage: caw start [--user]')).hint).toBe(
      'usage: caw start [--user]',
    );
    expect(thrownBy(() => resolveScope({}, { user: true, repo: 'R' })).hint).toBeUndefined();
  });

  it('does not change the values it was given', () => {
    const values: ScopeSelectors = { user: false, task: 'demo' };
    const copy = { ...values };
    resolveScope({ defaultScope: 'user' }, values);
    expect(values).toEqual(copy);
  });
});

// ---- the wording of the app (06 2.2) -----------------------------------------------------------------------------------------------

describe('appCommandText: the selector of the app instance in a suggested command', () => {
  it('drops --task user from a command of the lifecycle family, which acts on the app by default', () => {
    for (const command of ['start', 'stop', 'restart', 'status', 'serve', 'verify', 'doctor', 'check']) {
      expect(appCommandText(`mcs ${command} --task user`), command).toBe(`mcs ${command}`);
      expect(appCommandText(`caw ${command} --task user`), command).toBe(`caw ${command}`);
    }
  });

  it('turns it into --user for a command that defaults to a task, whatever the words around it', () => {
    expect(appCommandText('mcs upgrade --task user --restart')).toBe('mcs upgrade --user --restart');
    expect(appCommandText('mcs backup restore --task user --id b-1 --yes')).toBe(
      'mcs backup restore --user --id b-1 --yes',
    );
    expect(appCommandText('mcs db rebuild --task user --yes --confirm user')).toBe(
      'mcs db rebuild --user --yes --confirm user',
    );
    expect(appCommandText('mcs instances repair --task user')).toBe('mcs instances repair --user');
  });

  it('words every command of a sentence, in backticks or not', () => {
    expect(appCommandText('runtime 7 does not answer; run `mcs doctor --task user` or `mcs restart --task user`')).toBe(
      'runtime 7 does not answer; run `mcs doctor` or `mcs restart`',
    );
    expect(
      appCommandText(
        'the runtime code changed: run `mcs restart --task user` (or `mcs upgrade --task user --restart` when the database needs an upgrade)',
      ),
    ).toBe(
      'the runtime code changed: run `mcs restart` (or `mcs upgrade --user --restart` when the database needs an upgrade)',
    );
    expect(appCommandText('hint: mcs start --task user')).toBe('hint: mcs start');
  });

  it('keeps what is not a command of the app: another slug, a longer slug, a task command of a person', () => {
    for (const text of [
      'mcs start --task demo',
      'mcs start --task user2',
      'mcs start --task user-old',
      'mcs start --task users',
      'never started: run `caw start`',
      'pass --task user to a command',
      '',
    ]) {
      expect(appCommandText(text), text).toBe(text);
    }
  });

  it('is its own fixed point', () => {
    for (const text of ['mcs doctor --task user', 'mcs backup restore --task user --id b-1', 'plain']) {
      expect(appCommandText(appCommandText(text))).toBe(appCommandText(text));
    }
  });
});

describe('inAppScope: every string of a JSON-like value', () => {
  it('words strings in arrays and objects, at any depth, and keeps everything else', () => {
    const when = new Date(0);
    const value = {
      hint: 'mcs start --task user',
      count: 3,
      flag: false,
      none: null,
      when,
      lines: ['ok', 'run `mcs verify --task user`'],
      nested: { deeper: [{ hint: 'mcs backup --task user' }] },
    };
    expect(inAppScope(value)).toEqual({
      hint: 'mcs start',
      count: 3,
      flag: false,
      none: null,
      when,
      lines: ['ok', 'run `mcs verify`'],
      nested: { deeper: [{ hint: 'mcs backup --user' }] },
    });
    expect(inAppScope(when)).toBe(when);
  });

  it('does not change the value it was given', () => {
    const value = { hint: 'mcs start --task user', lines: ['mcs stop --task user'] };
    inAppScope(value);
    expect(value).toEqual({ hint: 'mcs start --task user', lines: ['mcs stop --task user'] });
  });

  it('leaves a primitive alone', () => {
    expect(inAppScope(7)).toBe(7);
    expect(inAppScope(undefined)).toBeUndefined();
    expect(inAppScope(null)).toBeNull();
  });
});

describe('appErrorOf: an error of an app call', () => {
  const base: CliError = { code: 'START_FAILED', message: 'x', hint: null, details: null };

  it('words the message, the hint and the details', () => {
    expect(
      appErrorOf({
        ...base,
        message: 'the server was stopped (`mcs start --task user` starts it again)',
        hint: 'mcs doctor --task user',
        details: { next: ['mcs stop --task user'], pid: 7 },
      }),
    ).toEqual({
      code: 'START_FAILED',
      message: 'the server was stopped (`mcs start` starts it again)',
      hint: 'mcs doctor',
      details: { next: ['mcs stop'], pid: 7 },
    });
  });

  it('keeps an absent hint and absent details absent', () => {
    expect(appErrorOf(base)).toEqual(base);
  });

  it('a TASK_NOT_FOUND says to start the app once, whatever hint the engine gave', () => {
    const error: CliError = {
      code: 'TASK_NOT_FOUND',
      message: 'no task.json in X',
      hint: 'mcs init --slug user',
      details: null,
    };
    expect(appErrorOf(error)).toEqual({ ...error, hint: APP_NOT_CREATED_HINT });
    expect(appErrorOf({ ...error, hint: null }).hint).toBe(APP_NOT_CREATED_HINT);
    expect(APP_NOT_CREATED_HINT).toBe('run `caw start` once to create the app instance');
  });
});

// ---- which commands default to the app (06 2.2) ----------------------------------------------------------------------------------

/** The lifecycle family: without a selector these act on the app. */
const LIFECYCLE_FAMILY: readonly string[] = [
  'start',
  'stop',
  'restart',
  'status',
  'serve',
  'verify',
  'doctor',
  'check',
];

/**
 * The commands that exist only for the app (06 2.2, the commands package adds them): they may default to the app and are never
 * required to. Every other command is a task command.
 */
const APP_ONLY: readonly string[] = ['open', 'autostart', 'config get', 'config set'];

const isAppOnly = (name: string): boolean => APP_ONLY.some((word) => name === word || name.startsWith(`${word} `));

interface Found {
  readonly name: string;
  readonly defaultScope: unknown;
}

function commandOf(value: unknown): Found | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('name' in value) || typeof value.name !== 'string' || !('options' in value) || !('run' in value)) return null;
  return { name: value.name, defaultScope: 'defaultScope' in value ? value.defaultScope : undefined };
}

/** Every command definition exported by a module of `commands/` or `commands/hooks/` (tests excluded). */
async function allCommands(): Promise<readonly Found[]> {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commands');
  const files = [root, path.join(root, 'hooks')].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => path.join(dir, name)),
  );
  const found: Found[] = [];
  for (const file of files) {
    const loaded: unknown = await import(pathToFileURL(file).href);
    if (typeof loaded !== 'object' || loaded === null) continue;
    for (const value of Object.values(loaded)) {
      const command = commandOf(value);
      if (command !== null) found.push(command);
    }
  }
  return found;
}

describe('the default scope of the commands', () => {
  it('the lifecycle family defaults to the app; every other command stays a task command (the commands of the app apart)', async () => {
    const commands = await allCommands();
    const names = commands.map((c) => c.name);
    for (const name of LIFECYCLE_FAMILY) expect(names, `the command ${name} exists`).toContain(name);
    expect(commands.length).toBeGreaterThan(LIFECYCLE_FAMILY.length);
    for (const command of commands) {
      const actual = command.defaultScope === 'task' ? undefined : command.defaultScope;
      if (LIFECYCLE_FAMILY.includes(command.name)) {
        expect(actual, `the default scope of ${command.name}`).toBe('user');
      } else if (!isAppOnly(command.name)) {
        expect(actual, `the default scope of ${command.name}`).toBeUndefined();
      }
    }
  }, 60_000);
});
