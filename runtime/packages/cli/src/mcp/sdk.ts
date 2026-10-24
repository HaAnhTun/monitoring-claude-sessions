// The one file that imports the MCP SDK (ADR 0060 point 2). Everything else in `mcp/` (the tool table, the rendering, the limits, the
// command) uses the two functions below and plain types, so a move between SDK lines changes this file and `package.json` only.
//
// The server is the `McpServer` of the pinned v1 package with two handlers on its protocol layer, `tools/list` and `tools/call`, and
// no registered tool: the SDK's own argument validation would put a library message (and a name taken from the request) into the
// answer, and ADR 0060 point 5 says that an error never echoes a value of the request, so the words of every refusal are ours.
// Tools only: no resources, no prompts, no sampling, no elicitation, no HTTP, no listener. The transport is the SDK's stdio
// transport; nothing else in the process writes to stdout while it runs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

export interface SdkToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** A JSON Schema of type object. */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties: boolean;
  };
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

/** The result of a tool call as the protocol carries it. */
export interface SdkToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
}

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  /** Sent to the client in the initialize result. */
  readonly instructions: string;
  readonly tools: readonly SdkToolDescriptor[];
  /** Runs a tool. `null` means that no such tool exists: the call is answered with a protocol error. */
  readonly call: (name: string, args: unknown) => Promise<SdkToolResult | null>;
  /** Transport and protocol problems (a line that is not JSON, a closed pipe). Never given a request value to print. */
  readonly onError?: (error: unknown) => void;
}

/** A server that is built but not connected. */
export interface McpServerHandle {
  readonly mcp: McpServer;
}

/** The server with its two handlers. It serves nothing until `serve` connects it. */
export function createMcpServer(options: McpServerOptions): McpServerHandle {
  const mcp = new McpServer(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} }, instructions: options.instructions },
  );
  const listed = options.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: tool.inputSchema.type,
      properties: tool.inputSchema.properties,
      additionalProperties: tool.inputSchema.additionalProperties,
      ...(tool.inputSchema.required === undefined ? {} : { required: [...tool.inputSchema.required] }),
    },
    annotations: { ...tool.annotations },
  }));
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await options.call(request.params.name, request.params.arguments);
    if (result === null) throw new McpError(ErrorCode.InvalidParams, 'unknown tool');
    return {
      content: result.content.map((block) => ({ ...block })),
      ...(result.isError === true ? { isError: true } : {}),
    };
  });
  if (options.onError !== undefined) mcp.server.onerror = options.onError;
  return { mcp };
}

/**
 * Serves over stdio until the client closes stdin (or the transport closes), then resolves. The SDK transport does not watch for
 * the end of stdin, so this does: the process must end within 100 ms of the pipe closing.
 */
export async function serve(handle: McpServerHandle): Promise<void> {
  const { mcp } = handle;
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    mcp.server.onclose = resolve;
  });
  const onEnd = (): void => {
    void mcp.close();
  };
  process.stdin.once('end', onEnd);
  process.stdin.once('close', onEnd);
  try {
    await mcp.connect(transport);
    await closed;
  } finally {
    process.stdin.off('end', onEnd);
    process.stdin.off('close', onEnd);
  }
}
