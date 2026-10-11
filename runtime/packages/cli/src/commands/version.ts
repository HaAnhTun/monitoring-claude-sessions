// `version` (01 6.3, 5.2): the runtime version, code stamp, Node version and build state. Option table and rendering only.
import { hostPlatform, opsVersion } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'version',
  summary: 'print the runtime version, code stamp, Node version and whether the build is current',
  synopsis: '[--short]',
  options: {
    short: { type: 'boolean', description: 'print only "mcs <version>"' },
  },
  async run(ctx) {
    const result = await opsVersion(ctx.op, ctx.deps);
    // `legacyEngine.version` (read from the legacy sources by the legacy-engine work package) is not known here: null.
    const legacy = ctx.deps.legacyEngine === undefined ? null : await ctx.deps.legacyEngine().catch(() => null);
    return {
      data: {
        runtimeVersion: result.version,
        codeStamp: result.code,
        buildCurrent: result.build === 'unknown' ? null : result.build === 'current',
        node: result.node,
        platform: hostPlatform,
        arch: process.arch,
        legacyEngine: { python: legacy?.exe ?? null, version: null },
      },
      text: [ctx.args.flag('short') ? `mcs ${result.version}` : result.text],
    };
  },
};
