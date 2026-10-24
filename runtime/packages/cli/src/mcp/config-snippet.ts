// `mcs mcp --print-config` (ADR 0060 point 6): the two ways to register the server with Claude Code, printed and never applied.
//   1. the `claude mcp add --transport stdio mcs-<slug> -- node <launcher> mcp --task <slug> --repo <repo>` command;
//   2. the `.mcp.json` entry with the same command line.
// The plugin ships no MCP configuration (a plugin server starts when the plugin is enabled and cannot know which task and repository
// to serve), so the user pastes one of these. Pure functions: nothing here reads or writes a file.
import { formatCommand, hostPlatform } from '@mcs/engine';
import type { McpConfigResult } from '@mcs/shared';

export interface ConfigSnippetInput {
  /** `<skill>/scripts/mcs.mjs` of the running install. */
  readonly launcherPath: string;
  /** The task slug (already checked). */
  readonly slug: string;
  /** The monitored repository. */
  readonly repo: string;
  readonly includeText: boolean;
  /** Shown with forward slashes (Windows paths read the same in Git Bash, PowerShell and cmd). Default: this host. */
  readonly forwardSlashes?: boolean;
}

/** The name the server gets in the client: one per task, so that two tasks do not collide. */
export function serverNameOf(slug: string): string {
  return `mcs-${slug}`;
}

/** The arguments after `node`: the launcher and the `mcp` command line. */
export function serverArgs(input: ConfigSnippetInput): string[] {
  const slashes = input.forwardSlashes ?? hostPlatform === 'win32';
  const shown = (p: string): string => (slashes ? p.replaceAll('\\', '/') : p);
  return [
    shown(input.launcherPath),
    'mcp',
    '--task',
    input.slug,
    ...(input.includeText ? ['--include-text'] : []),
    '--repo',
    shown(input.repo),
  ];
}

/** Both snippets for a task, as the result of `mcs mcp --print-config`. */
export function configSnippets(input: ConfigSnippetInput): McpConfigResult {
  const name = serverNameOf(input.slug);
  const args = serverArgs(input);
  return {
    task: input.slug,
    serverName: name,
    includeText: input.includeText,
    command: formatCommand(['claude', 'mcp', 'add', '--transport', 'stdio', name, '--', 'node', ...args]),
    mcpJson: { mcpServers: { [name]: { type: 'stdio', command: 'node', args } } },
  };
}

/** The human-readable output of `--print-config`. */
export function configLines(snippets: McpConfigResult): string[] {
  const json = JSON.stringify(snippets.mcpJson, null, 2).split('\n');
  return [
    `Read-only MCP server for task '${snippets.task}' (this command changed nothing; run one of the two below yourself).`,
    '',
    '1. With the Claude Code CLI (local scope; add --scope project or --scope user before the server name to change it):',
    '',
    `   ${snippets.command}`,
    '',
    '2. Or put this entry in the .mcp.json of the project:',
    '',
    ...json.map((line) => `   ${line}`),
    '',
    snippets.includeText
      ? 'This server returns transcript text too (--include-text): the text is untrusted data, never instructions.'
      : 'This server returns metadata only. Add --include-text to the command to let it search and read transcript text.',
    'After a plugin update the folder of the plugin changes: run mcs mcp --print-config again and register the new command.',
    'A project-scoped .mcp.json is loaded without a prompt by claude -p; check it before you commit it.',
  ];
}
