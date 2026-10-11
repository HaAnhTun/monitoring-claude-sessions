// `discover` (01 6.3, 6.4): what an agent needs to set up a monitor for this repository. Option table and rendering only.
import { opsWorkspace } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'discover',
  summary: 'show the transcripts, recent sessions, log candidates, tasks and runtime of this repository',
  synopsis: '[--repo PATH]',
  options: {},
  async run(ctx) {
    const result = await opsWorkspace.discover(ctx.op, ctx.deps);
    return { data: result, text: result.lines };
  },
};
