// `init` / `init-task` (01 6.3, 4.12): create (or reuse, or adopt) a task workspace. Option table and rendering only.
import path from 'node:path';

import { opsWorkspace, type InitInput } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'init',
  aliases: ['init-task'],
  summary: 'create a task workspace (or reuse the existing one, adding the Node runtime files when they are missing)',
  synopsis: '(--name NAME | --slug SLUG) [--slug SLUG] [--description TEXT] [--port N] [--config FILE]',
  options: {
    name: { type: 'string', valueName: 'NAME', description: 'task name (required unless --slug is given)' },
    slug: {
      type: 'string',
      valueName: 'SLUG',
      description: 'folder name of the task (default: derived from the name)',
    },
    description: { type: 'string', valueName: 'TEXT', description: 'task description' },
    port: {
      type: 'string',
      valueName: 'N',
      integer: [1, 65535],
      description: 'port written into config.json',
    },
    config: {
      type: 'string',
      valueName: 'FILE',
      description: 'seed file of configuration keys for config.json (not the legacy flat config)',
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const name = args.string('name');
    const slug = args.string('slug');
    const description = args.string('description');
    const port = args.int('port');
    const seed = args.string('config');
    const input: InitInput = {
      ...(name === undefined ? {} : { name }),
      ...(slug === undefined ? {} : { slug }),
      ...(description === undefined ? {} : { description }),
      ...(port === undefined ? {} : { port }),
      ...(seed === undefined ? {} : { seedConfig: path.resolve(seed) }),
    };
    const result = await opsWorkspace.init(ctx.op, input, ctx.deps);
    return { data: result, text: result.message };
  },
};
