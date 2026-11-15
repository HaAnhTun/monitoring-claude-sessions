// `autostart enable|disable|status` (06 2.7): the optional Startup shortcut that starts the app at sign-in, minimized and without a
// browser. Windows only; off Windows `status` and `disable` say so (exit 0) and `enable` fails with `UNSUPPORTED_PLATFORM`.
// Rendering only; the operations are `autostartStatus`, `enableAutostart` and `disableAutostart` of the engine, and the shortcut
// itself is made there. `enable` names the launcher of this call and the Node that runs it, which is what the shortcut will run.
import { autostartStatus, disableAutostart, enableAutostart, type AutostartTarget, type OpContext } from '@mcs/engine';
import type { AutostartStatus } from '@mcs/shared';

import type { CommandDefinition, CommandResult } from '../main.ts';

/** The operations of the engine, replaceable in tests. */
export interface AutostartOps {
  autostartStatus(ctx: OpContext, o: Pick<AutostartTarget, 'launcherPath'>): Promise<AutostartStatus>;
  enableAutostart(ctx: OpContext, o: AutostartTarget): Promise<AutostartStatus>;
  disableAutostart(ctx: OpContext): Promise<AutostartStatus>;
}

const REAL_OPS: AutostartOps = { autostartStatus, enableAutostart, disableAutostart };

/** What a person reads at sign-in: the app is up, the browser is not, and a login link is one command away. */
const AT_SIGN_IN = 'at sign-in the app starts in the background without a browser; run `caw open` for a login link';

/** The text of 06 2.7: the state, then the shortcut and what it runs. */
export function autostartLines(status: AutostartStatus): string[] {
  if (!status.supported) return ['autostart: not supported on this system'];
  if (!status.enabled) return ['autostart: off'];
  const lines = ['autostart: on'];
  if (status.shortcut !== null) lines.push(`  shortcut: ${status.shortcut}`);
  if (status.target !== null) {
    lines.push(`  runs:     "${status.target}"${status.arguments === null ? '' : ` ${status.arguments}`}`);
  }
  return lines;
}

/** A stale shortcut or a missing `APPDATA` is a note of the operation: a warning, never a failure. */
function resultOf(status: AutostartStatus, extra: readonly string[] = []): CommandResult {
  return {
    data: status,
    text: [...autostartLines(status), ...extra],
    warnings: status.supported && status.note !== null ? [status.note] : [],
  };
}

const COMMON = {
  synopsis: '',
  options: {},
  defaultScope: 'user',
  userOnly: true,
} as const satisfies Partial<CommandDefinition>;

export function makeCommands(
  ops: AutostartOps = REAL_OPS,
  nodePath: string = process.execPath,
): { enable: CommandDefinition; disable: CommandDefinition; status: CommandDefinition } {
  return {
    enable: {
      ...COMMON,
      name: 'autostart enable',
      summary: 'start the app at sign-in (a Startup shortcut, Windows only; it starts without a browser)',
      async run(ctx) {
        const status = await ops.enableAutostart(ctx.op, { launcherPath: ctx.op.launcherPath, nodePath });
        return resultOf(status, [AT_SIGN_IN]);
      },
    },
    disable: {
      ...COMMON,
      name: 'autostart disable',
      summary: 'remove the Startup shortcut',
      async run(ctx) {
        return resultOf(await ops.disableAutostart(ctx.op));
      },
    },
    status: {
      ...COMMON,
      name: 'autostart status',
      summary: 'show whether the app starts at sign-in, and what the shortcut runs',
      async run(ctx) {
        return resultOf(await ops.autostartStatus(ctx.op, { launcherPath: ctx.op.launcherPath }));
      },
    },
  };
}

const COMMANDS = makeCommands();

export const enableCommand: CommandDefinition = COMMANDS.enable;
export const disableCommand: CommandDefinition = COMMANDS.disable;
export const statusCommand: CommandDefinition = COMMANDS.status;
