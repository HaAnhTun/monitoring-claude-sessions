// The tool table of the MCP server: the names and annotations of ADR 0060, the validation and the ranges of the arguments, the JSON
// Schemas of `tools/list`, each handler over a fake runtime, the read-only view of the reader, and a static scan of the folder.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InstanceReader } from '@mcs/engine';
import { McsError } from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ArgumentError,
  LIST_LIMIT_MAX,
  READ_METHODS,
  TEXT_WINDOW_MAX,
  TOOL_ANNOTATIONS,
  inputSchemaOf,
  readOnlyView,
  toolTable,
  validateArgs,
  type McpReader,
  type StatusSource,
  type ToolDef,
  type ToolRuntime,
} from './tools.ts';

const SID = '11111111-2222-4333-8444-555555555555';
const METADATA_TOOLS = [
  'mcs_instance_status',
  'mcs_overview',
  'mcs_list_sessions',
  'mcs_get_session',
  'mcs_usage',
  'mcs_errors',
  'mcs_alerts',
  'mcs_verify_completion',
];
const TEXT_TOOLS = ['mcs_search_transcript', 'mcs_search_transcripts', 'mcs_read_transcript'];

function tool(name: string, includeText = true): ToolDef {
  const found = toolTable(includeText).find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe('the table', () => {
  it('has the metadata tools by default and the three transcript tools only with --include-text', () => {
    expect(toolTable(false).map((t) => t.name)).toEqual(METADATA_TOOLS);
    expect(toolTable(true).map((t) => t.name)).toEqual([...METADATA_TOOLS, ...TEXT_TOOLS]);
    expect(toolTable(false).every((t) => !t.text)).toBe(true);
    expect(
      toolTable(true)
        .filter((t) => t.text)
        .map((t) => t.name),
    ).toEqual(TEXT_TOOLS);
  });

  it('names every tool mcs_ plus lower-case words, and none of them as something that writes', () => {
    for (const t of toolTable(true)) {
      expect(t.name).toMatch(/^mcs_[a-z_]+$/);
      expect(t.name).not.toMatch(
        /start|stop|restart|write|delete|remove|export|backup|install|configure|set_|run|exec|kill|clean/,
      );
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.title.length).toBeGreaterThan(2);
    }
  });

  it('marks every tool read-only, not destructive, idempotent and closed-world', () => {
    expect(TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('says in the description of every transcript tool that the text is untrusted data', () => {
    for (const name of TEXT_TOOLS) expect(tool(name).description).toMatch(/untrusted data/);
  });

  it('says in the description of every metadata tool that it returns no transcript text', () => {
    for (const name of METADATA_TOOLS.filter((n) => n !== 'mcs_instance_status')) {
      expect(tool(name).description, name).toMatch(/Metadata only/);
    }
  });
});

describe('the arguments', () => {
  it('give the JSON Schema of an object with the declared properties only and the required ones listed', () => {
    const schema = inputSchemaOf(tool('mcs_get_session').fields) as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['session']);
    expect(Object.keys(schema.properties)).toEqual(['session', 'events']);
    expect(schema.properties['events']).toMatchObject({ type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX });
    expect(schema.properties['session']).toMatchObject({ type: 'string', minLength: 4, maxLength: 36 });
    expect(inputSchemaOf({})).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('give every list tool a limit of at most 50 and the transcript window one of at most 50 entries', () => {
    for (const name of [
      'mcs_list_sessions',
      'mcs_usage',
      'mcs_errors',
      'mcs_alerts',
      'mcs_search_transcript',
      'mcs_search_transcripts',
    ]) {
      const limit = tool(name).fields['limit'];
      expect(limit, name).toMatchObject({ kind: 'integer', min: 1, max: LIST_LIMIT_MAX });
    }
    expect(tool('mcs_read_transcript').fields['limit']).toMatchObject({
      kind: 'integer',
      min: 1,
      max: TEXT_WINDOW_MAX,
    });
    expect(LIST_LIMIT_MAX).toBe(50);
    expect(TEXT_WINDOW_MAX).toBe(50);
  });

  it('accept nothing for a tool without arguments and treat missing arguments as an empty object', () => {
    expect(validateArgs({}, undefined)).toEqual({});
    expect(validateArgs({}, null)).toEqual({});
    expect(validateArgs({}, {})).toEqual({});
    expect(() => validateArgs({}, { extra: 1 })).toThrow(ArgumentError);
  });

  it('refuse an unknown name, a non-object and a wrong type, naming a declared field but never a value', () => {
    const fields = tool('mcs_list_sessions').fields;
    expect(() => validateArgs(fields, 'text')).toThrow(ArgumentError);
    expect(() => validateArgs(fields, [])).toThrow(ArgumentError);
    expect(() => validateArgs(fields, { SECRET_KEY: 1 })).toThrow(ArgumentError);
    for (const bad of [
      { limit: '5' },
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { limit: Number.NaN },
      { all: 'yes' },
      { state: 3 },
    ]) {
      let caught: unknown;
      try {
        validateArgs(fields, bad);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(bad)).toBeInstanceOf(ArgumentError);
      expect((caught as ArgumentError).field, JSON.stringify(bad)).toBe(Object.keys(bad)[0]);
      expect((caught as ArgumentError).message).toBe('invalid arguments');
    }
    try {
      validateArgs(fields, { SECRET_KEY: 1 });
    } catch (error) {
      expect((error as ArgumentError).field).toBeNull();
    }
  });

  it('accept the values in range', () => {
    expect(
      validateArgs(tool('mcs_list_sessions').fields, { limit: 50, state: 'active', since: '24h', all: true }),
    ).toEqual({
      limit: 50,
      state: 'active',
      since: '24h',
      all: true,
    });
  });

  it('check enums, patterns and lengths, and refuse a 1 MB string without walking it', () => {
    expect(() => validateArgs(tool('mcs_usage').fields, { by: 'week' })).toThrow(ArgumentError);
    expect(validateArgs(tool('mcs_usage').fields, { by: 'tool' })).toEqual({ by: 'tool' });
    expect(() => validateArgs(tool('mcs_get_session').fields, {})).toThrow(ArgumentError);
    expect(() => validateArgs(tool('mcs_get_session').fields, { session: 'xyz!' })).toThrow(ArgumentError);
    expect(() => validateArgs(tool('mcs_get_session').fields, { session: '../../etc/passwd' })).toThrow(ArgumentError);
    expect(validateArgs(tool('mcs_get_session').fields, { session: SID.slice(0, 8) })).toEqual({
      session: SID.slice(0, 8),
    });
    expect(() => validateArgs(tool('mcs_errors').fields, { source: 'x'.repeat(1_000_000) })).toThrow(ArgumentError);
    expect(() => validateArgs(tool('mcs_search_transcript').fields, { session: SID.slice(0, 8) })).toThrow(
      ArgumentError,
    );
    expect(() => validateArgs(tool('mcs_search_transcript').fields, { session: SID, q: 'a'.repeat(201) })).toThrow(
      ArgumentError,
    );
    expect(() => validateArgs(tool('mcs_search_transcripts').fields, { q: 'a' })).toThrow(ArgumentError);
    expect(() => validateArgs(tool('mcs_read_transcript').fields, { session: SID, textChars: 100 })).toThrow(
      ArgumentError,
    );
    expect(() => validateArgs(tool('mcs_read_transcript').fields, { session: SID, limit: 51 })).toThrow(ArgumentError);
    expect(validateArgs(tool('mcs_read_transcript').fields, { session: SID, after: -1 })).toEqual({
      session: SID,
      after: -1,
    });
  });
});

// ---- handlers over a fake runtime ----------------------------------------------------------------------------------------------

function usageOf(): Record<string, unknown> {
  return {
    input: 10,
    output: 5,
    cacheCreation: 1,
    cacheRead: 2,
    total: 18,
    missing: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    turns: 2,
    synthetic: 0,
    unfinalized: 0,
    completeness: 'complete',
    scannedPct: 100,
    lowerBound: false,
  };
}

function sessionOf(label: string): Record<string, unknown> {
  return {
    id: SID,
    seq: 1,
    label,
    labelSource: 'rule',
    state: {
      state: 'completed',
      basis: 'observed',
      confidence: 'high',
      rule: 'S-1',
      evidence: [{ words: 'secret evidence' }],
    },
    startedAt: '2026-10-01T10:00:00.000Z',
    lastActivityAt: '2026-10-01T10:05:00.000Z',
    endedAt: '2026-10-01T10:06:00.000Z',
    durationMs: 360000,
    agentCount: 1,
    activeAgentCount: 0,
    toolCallCount: 3,
    pendingTools: 0,
    errorCount: 1,
    warningCount: 0,
    lastModel: 'model-x',
    usage: usageOf(),
    usageInclSubagents: usageOf(),
    cwd: '/should/not/appear',
    firstPrompt: 'PROMPT TEXT MUST NOT APPEAR',
  };
}

interface Calls {
  readonly reader: Record<string, ReturnType<typeof vi.fn>>;
  readonly showSession: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
}

function fakeRuntime(overrides: Partial<Record<(typeof READ_METHODS)[number], unknown>> = {}): {
  runtime: ToolRuntime;
  calls: Calls;
} {
  const reader: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of READ_METHODS) reader[name] = vi.fn(() => Promise.resolve(overrides[name] ?? {}));
  const showSession = vi.fn(() =>
    Promise.resolve({
      task: 'demo',
      mode: 'db',
      asOfSeq: 9,
      session: sessionOf('s'),
      agents: [],
      agentsTruncated: false,
      events: [],
      eventsTruncated: false,
      transcript: null,
    }),
  );
  const status = vi.fn((): Promise<StatusSource> =>
    Promise.resolve({
      running: false,
      probe: 'stopped',
      task: { id: 'demo', name: 'Demo', description: 'd' },
      recent_errors: Array.from({ length: 30 }, (_v, i) => ({
        at: '2026-10-01T00:00:00Z',
        where: 'w',
        message: `m${String(i)}`,
      })),
    }),
  );
  const runtime: ToolRuntime = {
    withReader: (run) => run({ mode: 'db', instanceId: 'i', ...reader } as unknown as McpReader),
    showSession: showSession as unknown as ToolRuntime['showSession'],
    status,
    nowMs: () => Date.parse('2026-10-02T00:00:00Z'),
  };
  return { runtime, calls: { reader, showSession, status } };
}

describe('the handlers', () => {
  it('mcs_list_sessions projects each session to metadata and reports whether more exist', async () => {
    const { runtime, calls } = fakeRuntime({
      sessions: {
        items: [sessionOf('build step A')],
        total: 1,
        totalIsLowerBound: false,
        limit: 20,
        nextCursor: 'c1',
        asOfSeq: 5,
      },
    });
    const out = await tool('mcs_list_sessions').run({ limit: 5, state: 'active' }, runtime);
    expect(out.asOfSeq).toBe(5);
    const data = out.data as { items: Record<string, unknown>[]; hasMore: boolean; total: number };
    expect(data.hasMore).toBe(true);
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({
      id: SID,
      label: 'build step A',
      state: 'completed',
      stateBasis: 'observed',
      errorCount: 1,
    });
    expect(data.items[0]).toHaveProperty('tokens.total', 18);
    const text = JSON.stringify(out.data);
    expect(text).not.toContain('PROMPT TEXT MUST NOT APPEAR');
    expect(text).not.toContain('/should/not/appear');
    expect(text).not.toContain('secret evidence');
    expect(calls.reader['sessions']).toHaveBeenCalledTimes(1);
    const query = calls.reader['sessions']?.mock.calls[0]?.[0] as { limit: number; state: string[] };
    expect(query.limit).toBe(5);
    expect(query.state).toEqual(['active']);
  });

  it('mcs_list_sessions asks for 20 sessions by default', async () => {
    const { runtime, calls } = fakeRuntime({
      sessions: { items: [], total: 0, totalIsLowerBound: false, limit: 20, nextCursor: null, asOfSeq: 1 },
    });
    await tool('mcs_list_sessions').run({}, runtime);
    expect((calls.reader['sessions']?.mock.calls[0]?.[0] as { limit: number }).limit).toBe(20);
  });

  it('mcs_list_sessions turns a value the route refuses into a USAGE failure without the value', async () => {
    const { runtime } = fakeRuntime();
    const failure = await tool('mcs_list_sessions')
      .run({ since: 'SECRET-WORD' }, runtime)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McsError);
    expect((failure as McsError).code).toBe('USAGE');
  });

  it('mcs_get_session returns the session read without text, through showSession', async () => {
    const { runtime, calls } = fakeRuntime();
    const out = await tool('mcs_get_session').run({ session: SID.slice(0, 8), events: 5 }, runtime);
    expect(calls.showSession).toHaveBeenCalledWith({ session: SID.slice(0, 8), events: 5 });
    expect(out.asOfSeq).toBe(9);
  });

  it('mcs_overview blanks the one-line tool summary of its events', async () => {
    const event = { id: 1, summary: 'rm -rf SECRET-COMMAND', toolName: 'Bash' };
    const { runtime } = fakeRuntime({
      overview: {
        asOfSeq: 3,
        metrics: [],
        recentActivity: [event],
        recentErrors: [event],
        alerts: { open: 0, critical: 0, items: [] },
      },
    });
    const out = await tool('mcs_overview').run({ range: '24h' }, runtime);
    const text = JSON.stringify(out.data);
    expect(text).not.toContain('SECRET-COMMAND');
    expect(text).toContain('Bash');
  });

  it('mcs_usage dispatches on the grouping to the matching reader method', async () => {
    const { runtime, calls } = fakeRuntime({ usage: { rows: [] }, series: { points: [] }, tools: { items: [] } });
    expect((await tool('mcs_usage').run({}, runtime)).data).toMatchObject({ by: 'model' });
    expect((await tool('mcs_usage').run({ by: 'session' }, runtime)).data).toMatchObject({ by: 'session' });
    expect((await tool('mcs_usage').run({ by: 'day' }, runtime)).data).toMatchObject({
      by: 'day',
      series: { points: [] },
    });
    expect((await tool('mcs_usage').run({ by: 'tool' }, runtime)).data).toMatchObject({
      by: 'tool',
      tools: { items: [] },
    });
    expect(calls.reader['usage']).toHaveBeenCalledTimes(2);
    expect(calls.reader['series']).toHaveBeenCalledTimes(1);
    expect(calls.reader['tools']).toHaveBeenCalledTimes(1);
  });

  it('mcs_errors passes the clock of the call so a preset becomes a time', async () => {
    const { runtime, calls } = fakeRuntime({ errors: [] });
    await tool('mcs_errors').run({ since: '1h', limit: 7 }, runtime);
    const query = calls.reader['errors']?.mock.calls[0]?.[0] as { since: string; limit: number };
    expect(query.limit).toBe(7);
    expect(new Date(query.since).toISOString()).toBe('2026-10-01T23:00:00.000Z');
  });

  it('mcs_alerts lists open alerts by default and passes the filters', async () => {
    const { runtime, calls } = fakeRuntime({ alerts: { items: [], nextCursor: null, asOfSeq: 2 } });
    const out = await tool('mcs_alerts').run({ severity: 'critical', limit: 3 }, runtime);
    expect(out.data).toEqual({ items: [], hasMore: false });
    expect(out.asOfSeq).toBe(2);
    expect(calls.reader['alerts']?.mock.calls[0]?.[0]).toMatchObject({
      status: ['open'],
      severity: ['critical'],
      limit: 3,
    });
  });

  it('mcs_verify_completion needs exactly one selector', async () => {
    const { runtime, calls } = fakeRuntime({ explainCompletion: { outcome: 'completed', asOfSeq: 4 } });
    const verify = tool('mcs_verify_completion');
    await expect(verify.run({}, runtime)).rejects.toBeInstanceOf(ArgumentError);
    await expect(verify.run({ session: SID, label: 'x' }, runtime)).rejects.toBeInstanceOf(ArgumentError);
    expect((await verify.run({ session: SID }, runtime)).asOfSeq).toBe(4);
    await verify.run({ label: 'build step A' }, runtime);
    await verify.run({ attempt: '' }, runtime);
    expect(calls.reader['explainCompletion']?.mock.calls.map((c): unknown => c[0])).toEqual([
      { sessionId: SID },
      { label: 'build step A' },
      { attemptPart: '' },
    ]);
  });

  it('mcs_instance_status shows a summary and at most ten errors', async () => {
    const { runtime } = fakeRuntime();
    const out = await tool('mcs_instance_status').run({}, runtime);
    const data = out.data as { running: boolean; state: string; recentErrors: unknown[]; task: { id: string } };
    expect(data).toMatchObject({ running: false, state: 'stopped', task: { id: 'demo' } });
    expect(data.recentErrors).toHaveLength(10);
    expect(JSON.stringify(out.data)).not.toContain('state_file');
  });

  it('the transcript tools build their queries from the arguments', async () => {
    const { runtime, calls } = fakeRuntime({
      searchTranscript: { hits: [] },
      searchTranscripts: { hits: [] },
      transcriptWindow: { events: [] },
    });
    await tool('mcs_search_transcript').run({ session: SID, q: 'needle', errors: true, kinds: 'say,tool' }, runtime);
    expect(calls.reader['searchTranscript']?.mock.calls[0]?.[0]).toMatchObject({
      session: SID,
      q: 'needle',
      errors: true,
      limit: 20,
      kinds: ['say', 'tool'],
    });
    await tool('mcs_search_transcripts').run({ q: 'needle', range: '7d', limit: 4 }, runtime);
    expect(calls.reader['searchTranscripts']?.mock.calls[0]?.[0]).toMatchObject({ q: 'needle', range: '7d', limit: 4 });
    await tool('mcs_read_transcript').run({ session: SID, limit: 10, before: 30 }, runtime);
    expect(calls.reader['transcriptWindow']?.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SID,
      limit: 10,
      before: 30,
      textChars: 2000,
      agent: 'main',
    });
  });
});

// ---- the reader is read-only ----------------------------------------------------------------------------------------------------

describe('readOnlyView', () => {
  it('has the read methods and nothing else: no exportTo, no close', async () => {
    const calls: string[] = [];
    const full: Record<string, unknown> = { mode: 'db', instanceId: 'inst' };
    for (const name of [...READ_METHODS, 'exportTo', 'close']) {
      full[name] = (...args: unknown[]) => {
        calls.push(`${name}:${String(args.length)}`);
        return Promise.resolve(name);
      };
    }
    const view = readOnlyView(full as unknown as InstanceReader);
    expect(Object.keys(view).sort()).toEqual(['instanceId', 'mode', ...READ_METHODS].sort());
    expect('exportTo' in view).toBe(false);
    expect('close' in view).toBe(false);
    await expect(view.errors({} as never)).resolves.toBe('errors');
    expect(calls).toEqual(['errors:1']);
    expect(view.mode).toBe('db');
  });

  it('keeps the methods bound to the reader', async () => {
    class Fake {
      readonly mode = 'api';
      readonly instanceId = 'x';
      private readonly secret = 'bound';
      sessions(): Promise<string> {
        return Promise.resolve(this.secret);
      }
    }
    const fake = new Fake() as unknown as Record<string, unknown>;
    for (const name of READ_METHODS) fake[name] ??= () => Promise.resolve(null);
    const view = readOnlyView(fake as unknown as InstanceReader);
    await expect(view.sessions({} as never)).resolves.toBe('bound');
  });

  it('is what the type promises: McpReader has no exportTo', () => {
    // a compile-time check kept as a test: assigning a reader view to a type that asks for `exportTo` must not type-check
    type NeedsExport = Pick<InstanceReader, 'exportTo'>;
    const assignable: McpReader extends NeedsExport ? true : false = false;
    expect(assignable).toBe(false);
  });
});

// ---- the files of the folder ---------------------------------------------------------------------------------------------------------

describe('the sources of packages/cli/src/mcp', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }));

  it('finds the five modules', () => {
    expect(sources.map((s) => s.name).sort()).toEqual([
      'config-snippet.ts',
      'render.ts',
      'sdk.ts',
      'server.ts',
      'tools.ts',
    ]);
  });

  it('imports no file writer, no process starter and no network module, and never calls fetch', () => {
    const forbidden =
      /from\s+'(node:)?(fs|fs\/promises|child_process|net|http|https|http2|dgram|tls|worker_threads|cluster)'/;
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(forbidden);
      expect(text, name).not.toMatch(/\bfetch\s*\(/);
      expect(text, name).not.toMatch(/require\s*\(\s*'(node:)?(fs|child_process|net|http|https)'/);
      expect(text, name).not.toMatch(/\bcreateServer\s*\(|\.listen\s*\(/);
      expect(text, name).not.toMatch(/\bspawn(Sync)?\s*\(|\bexec(File)?(Sync)?\s*\(/);
    }
  });

  it('keeps the SDK and zod in sdk.ts only', () => {
    for (const { name, text } of sources) {
      const imports = /from\s+'(@modelcontextprotocol\/|zod)/.test(text);
      expect(imports, name).toBe(name === 'sdk.ts');
    }
  });

  it('reads through the reader view, never through exportTo', () => {
    for (const { name, text } of sources) {
      if (name === 'tools.ts') continue;
      expect(text, name).not.toMatch(/exportTo/);
    }
    const tools = sources.find((s) => s.name === 'tools.ts')?.text ?? '';
    // the only mention is the comment that explains why the view leaves it out
    expect(tools.match(/exportTo/g)?.length ?? 0).toBeLessThanOrEqual(3);
    expect(tools).not.toMatch(/\.exportTo\(/);
  });
});
