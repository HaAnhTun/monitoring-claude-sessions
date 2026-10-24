// The MCP server of `mcs mcp` (ADR 0060): the tool table of `tools.ts` served through the SDK seam `sdk.ts`. This file joins them:
// it lists the tools with their annotations and JSON Schemas, validates the arguments of a call, runs the handler, renders the
// result (`render.ts`) and turns every failure into an `isError` result with a fixed message. It also builds the `ToolRuntime`
// of an instance: a reader opened and closed for each call (so a start or stop of the monitor between two calls is seen), the
// status operation, and the `showSession` operation. Nothing here writes a file, starts a process or opens a socket.
import { opsData, opsLifecycle, type DataDeps, type OpContext } from '@mcs/engine';

import { renderError, renderFailure, renderResult, DATA_NOTICE } from './render.ts';
import { serve, createMcpServer, type McpServerHandle, type SdkToolResult } from './sdk.ts';
import {
  ArgumentError,
  TOOL_ANNOTATIONS,
  inputSchemaOf,
  readOnlyView,
  toolTable,
  validateArgs,
  type ToolRuntime,
} from './tools.ts';

export const SERVER_NAME = 'mcs';

/** The `instructions` of the initialize result: what the server is, and the data notice. */
export const SERVER_INSTRUCTIONS =
  'Read-only view of one Claude Code session monitor: sessions, usage, errors, alerts and completion evidence. No tool changes ' +
  `anything. ${DATA_NOTICE}`;

/** At most this many tool calls run at once; the others wait (each call opens its own reader). */
export const MAX_CONCURRENT_CALLS = 4;

export interface ToolServerSettings {
  readonly version: string;
  readonly includeText: boolean;
  readonly runtime: ToolRuntime;
  /** Told about a failure that is not a refusal of the call (an unexpected exception): the code only, never a message. */
  readonly onToolFailure?: (tool: string, error: unknown) => void;
  /** Transport and protocol problems. */
  readonly onError?: (error: unknown) => void;
}

/** A counter that lets `limit` jobs run and queues the rest. */
function gate(limit: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    while (running >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await job();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/** The handler of `tools/call`: `null` for a tool that is not in the table. */
export function callHandler(
  settings: ToolServerSettings,
): (name: string, args: unknown) => Promise<SdkToolResult | null> {
  const tools = toolTable(settings.includeText);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const limited = gate(MAX_CONCURRENT_CALLS);
  return async (name, args) => {
    const tool = byName.get(name);
    if (tool === undefined) return null;
    return limited(async () => {
      try {
        return renderResult(await tool.run(validateArgs(tool.fields, args), settings.runtime));
      } catch (error) {
        if (error instanceof ArgumentError) return renderError('invalid_arguments');
        settings.onToolFailure?.(tool.name, error);
        return renderFailure(error);
      }
    });
  };
}

/** The server for `settings`, not yet connected. */
export function createToolServer(settings: ToolServerSettings): McpServerHandle {
  const tools = toolTable(settings.includeText);
  return createMcpServer({
    name: SERVER_NAME,
    version: settings.version,
    instructions: SERVER_INSTRUCTIONS,
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: inputSchemaOf(tool.fields),
      annotations: TOOL_ANNOTATIONS,
    })),
    call: callHandler(settings),
    ...(settings.onError === undefined ? {} : { onError: settings.onError }),
  });
}

/** Serves over stdio until the client closes its end. */
export async function runMcpServer(settings: ToolServerSettings): Promise<void> {
  await serve(createToolServer(settings));
}

/**
 * The runtime of the instance of `task`: every call probes the instance again and reads through the running monitor or, when it
 * is stopped, through its database (`opsData.withReader`). `deps` replaces the probe, the HTTP client or the reader in tests.
 */
export function createToolRuntime(op: OpContext, task: string, deps: DataDeps = {}): ToolRuntime {
  return {
    withReader: (run) => opsData.withReader(op, task, deps, (reader) => run(readOnlyView(reader))),
    showSession: async (input) =>
      (
        await opsData.showSession(
          op,
          { task, session: input.session, ...(input.events === undefined ? {} : { events: input.events }) },
          deps,
        )
      ).result,
    status: async () => (await opsLifecycle.status(op, { task })).report,
    nowMs: () => op.clock.now(),
  };
}
