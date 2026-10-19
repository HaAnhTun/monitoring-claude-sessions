// `diagnostics` (01 6.4, V4): writes the privacy-safe bundle `mcs.diagnostics/1` to a new file and prints its path. Option table
// and rendering only; the operation is `ops.diagnostics.bundle`.
import path from 'node:path';

import { opsDiagnostics } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(
  ops: Pick<typeof opsDiagnostics, 'bundle' | 'bundleLines'> = opsDiagnostics,
): CommandDefinition {
  return {
    name: 'diagnostics',
    summary:
      'write a diagnostics report (checks, status, health, redacted configuration, log tail) that is safe to share',
    synopsis: '[--task SLUG] [--out FILE]',
    options: {
      task: { type: 'string', valueName: 'SLUG', description: 'the task to report on' },
      out: {
        type: 'string',
        valueName: 'FILE',
        description: 'the new file to write (default: logs/diagnostics-<UTC>.json of the task); never overwrites',
      },
    },
    async run(ctx) {
      const task = ctx.args.string('task');
      const out = ctx.args.string('out');
      const result = await ops.bundle(
        ctx.op,
        { ...(task === undefined ? {} : { task }), ...(out === undefined ? {} : { out: path.resolve(out) }) },
        ctx.deps,
      );
      return {
        data: { path: result.path, bytes: result.bytes, schema: result.bundle.schema, notes: result.bundle.notes },
        text: ops.bundleLines(result),
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
