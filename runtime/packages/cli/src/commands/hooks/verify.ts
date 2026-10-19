// `hooks verify` (01 6.3; 02 3.7): the seven checks that prove what Claude Code will run, for one instance and one settings file.
// It never edits a settings file. Option table and rendering only; the operation is `ops.hooks.verify`.
import path from 'node:path';

import { opsHooks } from '@mcs/engine';
import type { HooksVerifyResult } from '@mcs/shared';

import type { CommandDefinition } from '../../main.ts';
import { targetArgs, targetOptions } from './shared.ts';

/** `[ok] V1: detail`, `[FAIL] V3: detail`, `[skip] V7: detail`. */
export function verifyLines(result: HooksVerifyResult): string[] {
  return result.checks.map((check) => {
    const tag = check.ok === null ? 'skip' : check.ok ? 'ok' : 'FAIL';
    return `[${tag}] ${check.check}: ${check.detail}`;
  });
}

export function makeCommand(ops: Pick<typeof opsHooks, 'verify'> = opsHooks): CommandDefinition {
  return {
    name: 'hooks verify',
    summary:
      'check the settings file, the paths, the handler version, the route file and a synthetic probe (writes no settings)',
    synopsis: '--task SLUG [--scope project-local|user | --settings-file FILE]',
    options: targetOptions(true),
    async run(ctx) {
      const target = targetArgs(ctx.args, (file) => path.resolve(file));
      const result = await ops.verify(ctx.op, { ...target, task: target.task ?? '' });
      return {
        data: result,
        text: verifyLines(result),
        exitCode: result.checks.some((check) => check.ok === false) ? 1 : 0,
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
