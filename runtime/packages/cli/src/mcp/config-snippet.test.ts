// `mcs mcp --print-config`: the `claude mcp add` command and the `.mcp.json` entry. The command string must survive a round trip
// through a shell tokenizer for paths with spaces and shell syntax, and both snippets must say the same thing.
import { McpConfigResultSchema } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { configLines, configSnippets, serverArgs, serverNameOf } from './config-snippet.ts';

/** A POSIX-shell tokenizer for what `formatCommand` produces: words, double quotes with backslash escapes. */
function tokenize(command: string): string[] {
  const words: string[] = [];
  let current: string | null = null;
  let quoted = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command.charAt(i);
    if (quoted) {
      if (c === '\\') {
        i += 1;
        current = (current ?? '') + command.charAt(i);
      } else if (c === '"') {
        quoted = false;
      } else {
        current = (current ?? '') + c;
      }
    } else if (c === '"') {
      quoted = true;
      current = current ?? '';
    } else if (c === ' ') {
      if (current !== null) words.push(current);
      current = null;
    } else {
      current = (current ?? '') + c;
    }
  }
  if (current !== null) words.push(current);
  return words;
}

const BASE = {
  launcherPath: '/opt/skills/monitoring/scripts/mcs.mjs',
  slug: 'demo',
  repo: '/work/repo',
  includeText: false,
  forwardSlashes: true,
};

describe('configSnippets', () => {
  it('prints the claude mcp add command for the launcher, the task and the repository', () => {
    const out = configSnippets(BASE);
    expect(out.serverName).toBe('mcs-demo');
    expect(out.command).toBe(
      'claude mcp add --transport stdio mcs-demo -- node /opt/skills/monitoring/scripts/mcs.mjs mcp --task demo --repo /work/repo',
    );
    expect(McpConfigResultSchema.parse(out)).toEqual(out);
  });

  it('puts --include-text in both snippets only when asked', () => {
    const plain = configSnippets(BASE);
    const text = configSnippets({ ...BASE, includeText: true });
    expect(plain.command).not.toContain('--include-text');
    expect(plain.mcpJson.mcpServers['mcs-demo']?.args).not.toContain('--include-text');
    expect(text.command).toContain('--task demo --include-text --repo');
    expect(text.mcpJson.mcpServers['mcs-demo']?.args).toContain('--include-text');
    expect(text.includeText).toBe(true);
  });

  it('writes a .mcp.json entry that says the same as the command', () => {
    const out = configSnippets({ ...BASE, includeText: true });
    const entry = out.mcpJson.mcpServers['mcs-demo'];
    expect(Object.keys(out.mcpJson)).toEqual(['mcpServers']);
    expect(entry).toEqual({
      type: 'stdio',
      command: 'node',
      args: [
        '/opt/skills/monitoring/scripts/mcs.mjs',
        'mcp',
        '--task',
        'demo',
        '--include-text',
        '--repo',
        '/work/repo',
      ],
    });
    const words = tokenize(out.command);
    expect(words.slice(0, 7)).toEqual(['claude', 'mcp', 'add', '--transport', 'stdio', 'mcs-demo', '--']);
    expect(words.slice(7)).toEqual(['node', ...(entry?.args ?? [])]);
    expect(JSON.parse(JSON.stringify(out.mcpJson))).toEqual(out.mcpJson);
  });

  it.each([
    ['a space', '/home/some one/my repo', '/opt/my skills/monitoring/scripts/mcs.mjs'],
    ['a double quote', '/work/re"po', '/opt/s"k/scripts/mcs.mjs'],
    ['a dollar sign and a backtick', '/work/$HOME/re`po`', '/opt/$x/scripts/mcs.mjs'],
    ['a semicolon and an ampersand', '/work/a;b&c', '/opt/a;b/scripts/mcs.mjs'],
    ['a backslash at the end', '/work/repo\\', '/opt/skill/scripts/mcs.mjs'],
  ])('survives a shell tokenizer for a path with %s', (_name, repo, launcherPath) => {
    const out = configSnippets({ ...BASE, repo, launcherPath, forwardSlashes: false });
    const words = tokenize(out.command);
    expect(words.slice(8)).toEqual(out.mcpJson.mcpServers['mcs-demo']?.args);
    expect(words[8]).toBe(launcherPath);
    expect(words[words.length - 1]).toBe(repo);
    expect(words).toHaveLength(8 + 6);
  });

  it('shows Windows paths with forward slashes', () => {
    const out = configSnippets({
      ...BASE,
      launcherPath: 'C:\\skills\\mcs\\scripts\\mcs.mjs',
      repo: 'D:\\work\\my repo',
    });
    expect(out.mcpJson.mcpServers['mcs-demo']?.args[0]).toBe('C:/skills/mcs/scripts/mcs.mjs');
    expect(out.command).toContain('"D:/work/my repo"');
    expect(serverArgs({ ...BASE, forwardSlashes: false, repo: 'D:\\work' })[5]).toBe('D:\\work');
  });

  it('names the server after the task', () => {
    expect(serverNameOf('night-run')).toBe('mcs-night-run');
  });
});

describe('configLines', () => {
  it('explains both snippets, what the server returns and what to do after a plugin update', () => {
    const lines = configLines(configSnippets(BASE));
    const text = lines.join('\n');
    expect(text).toContain('changed nothing');
    expect(text).toContain('claude mcp add');
    expect(text).toContain('.mcp.json');
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('metadata only');
    expect(text).toContain('plugin update');
    expect(configLines(configSnippets({ ...BASE, includeText: true })).join('\n')).toContain('untrusted data');
  });
});
