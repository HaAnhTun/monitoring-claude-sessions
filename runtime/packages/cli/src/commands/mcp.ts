// `mcp` (ADR 0060): the read-only MCP server for one task over stdio, or with `--print-config` the commands that register it with
// Claude Code. In server mode the protocol owns stdout (the SDK writes the frames; this command prints nothing and returns no
// output), diagnostics go to stderr through the logger (warn level, or debug with `MCS_DEBUG=1`), and the call ends when the
// client closes stdin. The SDK is loaded only here, on the first line of server mode, so no other command pays for it.
import { opsWorkspace } from '@mcs/engine';
import { McsError, RUNTIME_VERSION } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { configLines, configSnippets } from '../mcp/config-snippet.ts';
import type * as McpServerModule from '../mcp/server.ts';

/** What the command needs from the outside; tests replace them. */
export interface McpCommandDeps {
  /** True when stdin is a terminal: a person typed the command instead of an MCP client starting it. */
  readonly stdinIsTerminal: () => boolean;
  /** The server module, loaded on demand. */
  readonly loadServer: () => Promise<typeof McpServerModule>;
}

const defaultDeps: McpCommandDeps = {
  stdinIsTerminal: () => process.stdin.isTTY,
  loadServer: () => import('../mcp/server.ts'),
};

export function makeCommand(deps: McpCommandDeps = defaultDeps): CommandDefinition {
  return {
    name: 'mcp',
    summary:
      'run the read-only MCP server of a task over stdio, or print the commands that register it with Claude Code',
    synopsis: '--task SLUG [--include-text]  |  --task SLUG --print-config [--include-text] [--json]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task whose data the server shows' },
      'include-text': {
        type: 'boolean',
        description: 'also offer the tools that search and read transcript text (untrusted data; off by default)',
      },
      'print-config': {
        type: 'boolean',
        description: 'print the `claude mcp add` command and the .mcp.json entry for this task and change nothing',
      },
    },
    async run(ctx) {
      const task = ctx.args.string('task') ?? '';
      const includeText = ctx.args.flag('include-text');
      if (ctx.args.flag('print-config')) {
        const ws = await opsWorkspace.openWorkspace(ctx.op, task);
        const snippets = configSnippets({
          launcherPath: ctx.op.launcherPath,
          slug: ws.slug,
          repo: ctx.op.repo,
          includeText,
        });
        return { data: snippets, text: configLines(snippets) };
      }
      if (ctx.json) {
        throw new McsError('USAGE', '--json only works with --print-config: the server speaks JSON-RPC on stdout', {
          hint: 'run mcs mcp --print-config --task SLUG --json to get the registration commands as JSON',
        });
      }
      if (deps.stdinIsTerminal()) {
        throw new McsError(
          'USAGE',
          'mcs mcp speaks the MCP protocol on stdin and stdout and must be started by an MCP client',
          {
            hint: `run mcs mcp --print-config --task ${task} to print the command that registers it with Claude Code`,
          },
        );
      }
      // fail early, with a clear error on stderr, when the task does not exist (each tool call opens its own reader)
      await opsWorkspace.openWorkspace(ctx.op, task);
      const server = await deps.loadServer();
      await server.runMcpServer({
        version: RUNTIME_VERSION,
        includeText,
        runtime: server.createToolRuntime(ctx.op, task),
        onToolFailure: (_tool, error) => {
          ctx.op.log.warn('mcp.tool_failed', { code: error instanceof McsError ? error.code : 'INTERNAL' });
        },
        onError: () => {
          ctx.op.log.debug('mcp.transport_error', { code: 'TRANSPORT' });
        },
      });
      return { data: null, text: [] };
    },
  };
}

export const command: CommandDefinition = makeCommand();
