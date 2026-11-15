// `start` (01 6.3, 4.7; 06 2.3): start the detached server of the app (the default) or of a task, or report the one that runs.
// Option table and rendering only; the operations are `opsApp.startUser` for the app and `ops.lifecycle.start` for a task.
// `restart` takes the same options, so the table and the input mapping live here.
//
// The app opens a browser at a login URL unless `--no-open`. That URL holds a one-time access code, which is a password for the
// terminals: it is printed only when the person asked for it (`--print`), or as the fallback when the browser could not be
// opened, and it is never part of the data of `--json` unless `--print` was given (06 5.2).
import {
  opsApp,
  opsLifecycle,
  type LogLevel,
  type StartInput,
  type UserLogin,
  type UserRestartResult,
  type UserStartInput,
  type UserStartResult,
} from '@mcs/engine';

import type { CommandDefinition, CommandResult, OptionTable, ParsedArgs } from '../main.ts';

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** The options of a start (01 6.3, 06 2.3); `restart` takes them all, `serve` the first three and its own `--open`. */
export const START_OPTIONS: OptionTable = {
  task: {
    type: 'string',
    valueName: 'SLUG',
    description:
      'task to start (task scope; "default" is created on demand); without --task, --repo and --root the app instance starts',
  },
  port: {
    type: 'string',
    valueName: 'N',
    integer: [1, 65535],
    description: 'first port to try (default: the port of the configuration); the next free one is used',
  },
  'log-level': {
    type: 'string',
    valueName: 'LEVEL',
    choices: LOG_LEVELS,
    description: 'log level of the server (default: the configuration)',
  },
  open: {
    type: 'boolean',
    conflictsWith: ['no-open'],
    description: 'open the dashboard in the browser once the server is up (the app does it unless --no-open)',
  },
  'timeout-ms': {
    type: 'string',
    valueName: 'MS',
    integer: [1000, 300_000],
    description: 'how long to wait for a healthy server (default: process.startTimeoutMs)',
  },
  // the options of the app (06 2.3): `--no-open` is accepted by a task too and ignored there, because the autostart shortcut and
  // scripts pass it whatever they start
  'no-open': {
    type: 'boolean',
    description: 'the app: do not open a browser and mint no login code (a task ignores it)',
  },
  window: {
    type: 'boolean',
    scope: 'user',
    conflictsWith: ['tab'],
    description: 'open the app in an Edge or Chrome app window (default: app.openAppWindow)',
  },
  tab: { type: 'boolean', scope: 'user', description: 'open the app in a tab of the default browser' },
  print: {
    type: 'boolean',
    scope: 'user',
    description: 'print a login URL (single use, a password) instead of opening a browser',
  },
};

/** The synopsis of `start` and `restart` (the latter adds `--force`). */
export const START_SYNOPSIS =
  '[--task SLUG] [--port N] [--log-level LEVEL] [--open | --no-open] [--window | --tab] [--print] [--timeout-ms MS]';

function logLevelOf(text: string | undefined): LogLevel | undefined {
  return LOG_LEVELS.find((level) => level === text);
}

/** The options as typed, without the ones that were not given (exactOptionalPropertyTypes). */
export function startInputOf(args: ParsedArgs): StartInput {
  const task = args.string('task');
  const port = args.int('port');
  const logLevel = logLevelOf(args.string('log-level'));
  const timeoutMs = args.int('timeout-ms');
  return {
    ...(task === undefined ? {} : { task }),
    ...(port === undefined ? {} : { port }),
    ...(logLevel === undefined ? {} : { logLevel }),
    ...(args.flag('open') ? { open: true } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** The options of a start of the app: the browser opens unless `--no-open`; there is no task to name. */
export function userStartInputOf(args: ParsedArgs): UserStartInput {
  const port = args.int('port');
  const logLevel = logLevelOf(args.string('log-level'));
  const timeoutMs = args.int('timeout-ms');
  const browser = args.flag('window') ? 'window' : args.flag('tab') ? 'tab' : undefined;
  return {
    ...(port === undefined ? {} : { port }),
    ...(logLevel === undefined ? {} : { logLevel }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    open: !args.flag('no-open'),
    ...(browser === undefined ? {} : { browser }),
    ...(args.flag('print') ? { print: true } : {}),
  };
}

/** The line of the fallback when no browser could be opened: the code was never used, so the person may use it. */
export function fallbackLoginLine(login: UserLogin): string {
  return `open: ${login.url}  (single use, ${String(login.ttlSeconds)} s)`;
}

/**
 * What `start` shows for the app. The login URL is in the data only with `--print`; when a browser could not be opened it is
 * shown as one line of text, and nowhere else.
 */
export function userStartResult(result: UserStartResult, print: boolean): CommandResult {
  const fallback = !print && result.opened === false && result.login !== null ? [fallbackLoginLine(result.login)] : [];
  return {
    data: print ? result : { ...result, login: null },
    text: [...result.message, ...fallback],
    warnings: result.warnings,
    exitCode: result.exitCode,
  };
}

/** The same for `restart`: the login of its start follows the rules of {@link userStartResult}. */
export function userRestartResult(result: UserRestartResult, print: boolean): CommandResult {
  const login = result.start.login;
  const fallback = !print && result.start.opened === false && login !== null ? [fallbackLoginLine(login)] : [];
  return {
    data: print ? result : { ...result, start: { ...result.start, login: null } },
    text: [...result.message, ...fallback],
    warnings: result.warnings,
    exitCode: result.exitCode,
  };
}

export function makeCommand(
  ops: Pick<typeof opsLifecycle, 'start'> = opsLifecycle,
  app: Pick<typeof opsApp, 'startUser'> = opsApp,
): CommandDefinition {
  return {
    name: 'start',
    summary:
      'start the app in the background and open it in the browser; with --task, start the monitor of a task (or report the one that runs)',
    synopsis: START_SYNOPSIS,
    options: START_OPTIONS,
    defaultScope: 'user',
    async run(ctx) {
      if (ctx.scope === 'user') {
        const result = await app.startUser(ctx.op, userStartInputOf(ctx.args));
        return userStartResult(result, ctx.args.flag('print'));
      }
      const result = await ops.start(ctx.op, startInputOf(ctx.args));
      return { data: result, text: result.message, warnings: result.warnings, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
