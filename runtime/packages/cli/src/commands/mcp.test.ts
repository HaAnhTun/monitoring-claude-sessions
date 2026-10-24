// `mcp` (ADR 0060 point 7): the options, the refusals before anything is read (a terminal on stdin, `--json` without `--print-config`),
// `--print-config` over a real task folder in a temp tree (it writes nothing), and server mode with the server module replaced.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { tasksRootOf, type OpContext } from '@mcs/engine';
import { McpConfigResultSchema, McsError } from '@mcs/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand, type McpCommandDeps } from './mcp.ts';

type Typed = Record<string, string | boolean>;

function contextOf(values: Typed, op: Partial<OpContext>, json = false): CommandContext {
  const text = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    op: op as OpContext,
    args: {
      positionals: [],
      string: text,
      strings: (name) => {
        const v = text(name);
        return v === undefined ? [] : [v];
      },
      flag: (name) => values[name] === true,
      int: () => undefined,
    },
    deps: {},
    json,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

let root = '';
let repo = '';

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcs-mcp-cmd-'));
  repo = path.join(root, 'my repo');
  const ws = path.join(tasksRootOf(repo), 'demo');
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, 'task.json'), JSON.stringify({ schema_version: 1, id: 'demo', name: 'FIXTURE demo' }));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

function opOf(): Partial<OpContext> {
  return {
    repo,
    root: tasksRootOf(repo),
    launcherPath: path.join(root, 'skill dir', 'scripts', 'mcs.mjs'),
    clock: { now: () => 0 },
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as OpContext['log'],
  };
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

const neverLoaded: McpCommandDeps = {
  stdinIsTerminal: () => false,
  loadServer: () => Promise.reject(new Error('the server must not load')),
};

describe('the definition', () => {
  it('is registered as mcp with --task required and the two flags', () => {
    expect(command.name).toBe('mcp');
    expect(Object.keys(command.options)).toEqual(['task', 'include-text', 'print-config']);
    expect(command.options['task']?.required).toBe(true);
    expect(command.options['include-text']?.type).toBe('boolean');
    expect(command.options['print-config']?.type).toBe('boolean');
    expect(command.interruptible).toBeUndefined();
  });
});

describe('refusals', () => {
  it('refuses to run with a terminal on stdin, pointing at --print-config, and loads nothing', async () => {
    const cmd = makeCommand({ ...neverLoaded, stdinIsTerminal: () => true });
    const failure = await cmd.run(contextOf({ task: 'demo' }, opOf())).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McsError);
    expect((failure as McsError).code).toBe('USAGE');
    expect((failure as McsError).hint).toContain('--print-config');
  });

  it('refuses --json without --print-config', async () => {
    const failure = await makeCommand(neverLoaded)
      .run(contextOf({ task: 'demo' }, opOf(), true))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McsError);
    expect((failure as McsError).code).toBe('USAGE');
    expect((failure as McsError).message).toContain('--print-config');
  });

  it('fails early for a task that does not exist, before the server module loads', async () => {
    const failure = await makeCommand(neverLoaded)
      .run(contextOf({ task: 'nope' }, opOf()))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McsError);
    expect((failure as McsError).code).toBe('TASK_NOT_FOUND');
  });

  it('refuses a task name that is not a slug, also for --print-config', async () => {
    for (const task of ['has space', 'quo"te', '../x']) {
      const failure = await makeCommand(neverLoaded)
        .run(contextOf({ task, 'print-config': true }, opOf()))
        .catch((error: unknown) => error);
      expect(failure, task).toBeInstanceOf(McsError);
      expect((failure as McsError).code, task).toBe('SLUG_INVALID');
    }
  });
});

describe('--print-config', () => {
  it('returns both snippets as data and as lines and writes nothing', async () => {
    const before = listing(root);
    const result = await makeCommand(neverLoaded).run(contextOf({ task: 'demo', 'print-config': true }, opOf(), true));
    const data = McpConfigResultSchema.parse(result.data);
    expect(data.task).toBe('demo');
    expect(data.serverName).toBe('mcs-demo');
    expect(data.includeText).toBe(false);
    expect(data.command).toContain('claude mcp add --transport stdio mcs-demo -- node');
    expect(data.command).toContain('"');
    const args = data.mcpJson.mcpServers['mcs-demo']?.args ?? [];
    expect(args.slice(1)).toEqual(['mcp', '--task', 'demo', '--repo', repo.split(path.sep).join('/')]);
    expect(args[0]).toContain('skill dir');
    expect((result.text ?? []).join('\n')).toContain('claude mcp add');
    expect(listing(root)).toEqual(before);
  });

  it('carries --include-text into the command', async () => {
    const result = await makeCommand(neverLoaded).run(
      contextOf({ task: 'demo', 'print-config': true, 'include-text': true }, opOf()),
    );
    expect(McpConfigResultSchema.parse(result.data).includeText).toBe(true);
    expect(McpConfigResultSchema.parse(result.data).command).toContain('--include-text');
  });
});

describe('server mode', () => {
  it('opens the server module, runs it for the task and returns no output', async () => {
    const runMcpServer = vi.fn(() => Promise.resolve());
    const createToolRuntime = vi.fn(() => ({ marker: 'runtime' }));
    const cmd = makeCommand({
      stdinIsTerminal: () => false,
      loadServer: () =>
        Promise.resolve({ runMcpServer, createToolRuntime } as unknown as Awaited<
          ReturnType<McpCommandDeps['loadServer']>
        >),
    });
    const op = opOf();
    const result = await cmd.run(contextOf({ task: 'demo', 'include-text': true }, op));
    expect(result).toEqual({ data: null, text: [] });
    expect(createToolRuntime).toHaveBeenCalledWith(op, 'demo');
    expect(runMcpServer).toHaveBeenCalledTimes(1);
    const settings = (
      runMcpServer.mock.calls[0] as unknown as [{ includeText: boolean; runtime: unknown; version: string }]
    )[0];
    expect(settings.includeText).toBe(true);
    expect(settings.runtime).toEqual({ marker: 'runtime' });
    expect(settings.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
