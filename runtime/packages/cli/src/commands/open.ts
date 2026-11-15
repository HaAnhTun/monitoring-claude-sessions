// `open` (06 2.3, 5.2): open the app in the browser at a login URL, starting it first when it does not run. The URL holds a
// one-time access code, which is a password for the terminals: it is printed only with `--print`, or as the one fallback line
// when no browser could be opened, and it is never part of the data of `--json` unless `--print` was given. Option table and
// rendering only; the operation is `opsApp.openUser`.
import { opsApp, type UserOpenInput, type UserOpenResult } from '@mcs/engine';

import type { CommandDefinition, CommandResult, ParsedArgs } from '../main.ts';
import { fallbackLoginLine } from './start.ts';

/** The options as typed, without the ones that were not given (exactOptionalPropertyTypes). */
export function userOpenInputOf(args: ParsedArgs): UserOpenInput {
  const timeoutMs = args.int('timeout-ms');
  const browser = args.flag('window') ? 'window' : args.flag('tab') ? 'tab' : undefined;
  return {
    ...(browser === undefined ? {} : { browser }),
    ...(args.flag('print') ? { print: true } : {}),
    ...(args.flag('no-start') ? { noStart: true } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * What `open` shows. The login is in the data only with `--print`; a browser that could not be opened leaves the login in the
 * result (the code was never used), which is shown as one line of text and nowhere else.
 */
export function userOpenResult(result: UserOpenResult, print: boolean): CommandResult {
  const login = result.login;
  const fallback = !print && login !== null ? [fallbackLoginLine(login)] : [];
  return {
    data: print ? result : { ...result, login: null },
    text: [...result.message, ...fallback],
    warnings: result.warnings,
    exitCode: result.exitCode,
  };
}

export function makeCommand(app: Pick<typeof opsApp, 'openUser'> = opsApp): CommandDefinition {
  return {
    name: 'open',
    summary: 'open the app in the browser (starting it when needed); --print gives a login URL instead',
    synopsis: '[--window | --tab] [--print] [--no-start] [--timeout-ms MS]',
    options: {
      window: {
        type: 'boolean',
        conflictsWith: ['tab'],
        description: 'open the app in an Edge or Chrome app window (default: app.openAppWindow)',
      },
      tab: { type: 'boolean', description: 'open the app in a tab of the default browser' },
      print: {
        type: 'boolean',
        description: 'print a login URL (single use, a password) instead of opening a browser',
      },
      'no-start': {
        type: 'boolean',
        description: 'do not start the app: fail with INSTANCE_NOT_RUNNING when it does not run',
      },
      'timeout-ms': {
        type: 'string',
        valueName: 'MS',
        integer: [1000, 300_000],
        description:
          'how long to wait for a healthy server when it has to be started (default: process.startTimeoutMs)',
      },
    },
    defaultScope: 'user',
    userOnly: true,
    async run(ctx) {
      const result = await app.openUser(ctx.op, userOpenInputOf(ctx.args));
      return userOpenResult(result, ctx.args.flag('print'));
    },
  };
}

export const command: CommandDefinition = makeCommand();
