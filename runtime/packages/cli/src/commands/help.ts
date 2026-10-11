// `help [command]` (01 6.3): the help pages, generated from the option tables. Option table and rendering only.
import { McsError } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { describeCommand } from '../render/json.ts';
import { commandHelpLines, generalHelpLines } from '../render/text.ts';

export const command: CommandDefinition = {
  name: 'help',
  summary: 'show the commands, or the options of one command',
  synopsis: '[command]',
  options: {},
  positionals: { max: 3 },
  async run(ctx) {
    const words = ctx.args.positionals;
    if (words.length === 0) {
      const all = await ctx.catalog.all();
      return {
        data: { commands: all.map((d) => ({ name: d.name, summary: d.summary })) },
        text: generalHelpLines(all, ctx.globalOptions),
      };
    }
    const found = await ctx.catalog.find(words);
    if (found === null) {
      throw new McsError('USAGE', `unknown command '${words.join(' ')}'`, {
        hint: "run 'mcs help' for the list of commands",
      });
    }
    return { data: describeCommand(found, ctx.globalOptions), text: commandHelpLines(found, ctx.globalOptions) };
  },
};
