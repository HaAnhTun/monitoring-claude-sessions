// `mcs mcp` through the real built CLI against a real instance (ADR 0060, WP-64): a raw JSON-RPC client (no SDK client) drives the stdio
// server. The handshake for four protocol versions, `tools/list`, every tool in API mode (the instance runs) and in DB mode (it is
// stopped, and the workspace stays byte for byte the same), the refusals (a bad argument, an unknown tool, a write-like name), what
// the results hold without and with `--include-text`, hostile text escaped, a result above the cap, stdout holding nothing but
// JSON-RPC lines, a quick exit when stdin closes, and `--print-config`. All data is synthetic (the testkit demo); the real `~/.claude`
// is never touched (`hermeticEnv`).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpConfigResultSchema, routes } from '@mcs/shared';
import {
  TranscriptBuilder,
  allocatePort,
  buildDemo,
  buildRepo,
  buildTaskWorkspace,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  makeTempDir,
  runCli,
  snapshotTree,
  startInstance,
  waitFor,
  type DemoLetter,
  type DemoResult,
  type StartedInstance,
} from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const temp = makeTempDir('mcp-int');
const SLUG = 'mcpint';
const LETTERS: readonly DemoLetter[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const CLI_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main.js');
const PERF = Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1;
const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(0x202e);
const FINAL_A = 'FIXTURE Backend compiles and all 214 unit tests pass. No untracked files.';
const TOOL_A = 'echo FIXTURE unit tests';
const PROMPT_A = 'compile the backend and run the unit tests';
const NOTICE_START = 'The fields of this result come from Claude Code session transcripts';
const BIG_SESSION = '3e1f7a52-0c4d-4b6e-9a18-2d5c8b7e4f01';

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

// ---- a raw JSON-RPC client over the stdio of the real command ----------------------------------------------------------------------

interface Rpc {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

interface Envelope {
  kind: string;
  readOnly: boolean;
  dataNotice: string;
  asOfSeq: number | null;
  truncated: boolean;
  data: unknown;
  hint?: string;
  error?: { code: string; message: string };
}

interface ToolReply {
  readonly rpc: Rpc;
  readonly isError: boolean;
  readonly text: string;
  readonly envelope: Envelope;
}

class RawMcp {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[] = [];
  stderr = '';
  private pending = '';
  private nextId = 1;
  private readonly waiters = new Map<number, (message: Rpc) => void>();
  readonly exited: Promise<{ code: number | null; at: number }>;

  constructor(args: readonly string[], env: Record<string, string>) {
    this.child = spawn(process.execPath, [CLI_ENTRY, 'mcp', ...args], {
      env,
      cwd: env['MCS_HOME'],
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.pending += chunk;
      for (;;) {
        const cut = this.pending.indexOf('\n');
        if (cut < 0) break;
        const line = this.pending.slice(0, cut);
        this.pending = this.pending.slice(cut + 1);
        this.stdoutLines.push(line);
        const message = this.tryParse(line);
        if (message?.id !== undefined && typeof message.id === 'number') this.waiters.get(message.id)?.(message);
      }
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.stdin.on('error', () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        resolve({ code, at: performance.now() });
      });
    });
  }

  private tryParse(line: string): Rpc | null {
    try {
      return JSON.parse(line) as Rpc;
    } catch {
      return null;
    }
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 30_000 * PERF): Promise<Rpc> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<Rpc>((resolve, reject) => {
      AbortSignal.timeout(timeoutMs).addEventListener(
        'abort',
        () => {
          this.waiters.delete(id);
          reject(
            new Error(`no answer to ${method} within ${String(timeoutMs)} ms; stderr: ${this.stderr.slice(0, 400)}`),
          );
        },
        { once: true },
      );
      this.waiters.set(id, (message) => {
        this.waiters.delete(id);
        resolve(message);
      });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  async initialize(protocolVersion = '2025-11-25', announce = true): Promise<Rpc> {
    const reply = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'FIXTURE raw client', version: '0.0.0' },
    });
    if (announce) this.notify('notifications/initialized');
    return reply;
  }

  async call(name: string, args?: unknown): Promise<ToolReply> {
    const rpc = await this.request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
    const content = (rpc.result?.['content'] ?? []) as { type: string; text: string }[];
    if (rpc.result === undefined) throw new Error(`protocol error for ${name}: ${JSON.stringify(rpc.error)}`);
    const text = content[0]?.text ?? '';
    return { rpc, isError: rpc.result['isError'] === true, text, envelope: JSON.parse(text) as Envelope };
  }

  /** Closes stdin and resolves with the exit code and the time the exit took. */
  async close(): Promise<{ code: number | null; ms: number }> {
    const started = performance.now();
    this.child.stdin.end();
    const gaveUp = new Promise<null>((resolve) => {
      AbortSignal.timeout(15_000).addEventListener(
        'abort',
        () => {
          resolve(null);
        },
        { once: true },
      );
    });
    const done = await Promise.race([this.exited, gaveUp]);
    if (done === null) {
      this.child.kill();
      throw new Error(`the server did not exit after stdin closed; stderr: ${this.stderr.slice(0, 400)}`);
    }
    return { code: done.code, ms: done.at - started };
  }

  /** Every line of stdout is one JSON-RPC message (the purity rule of ADR 0060 point 7). */
  assertPureStdout(): void {
    expect(this.pending, 'stdout ended inside a line').toBe('');
    for (const line of this.stdoutLines) {
      const message = this.tryParse(line);
      expect(message, `not JSON: ${line.slice(0, 120)}`).not.toBeNull();
      expect(message?.jsonrpc).toBe('2.0');
    }
  }

  get stdoutText(): string {
    return this.stdoutLines.join('\n');
  }
}

// ---- the instance --------------------------------------------------------------------------------------------------------------------

interface Live {
  readonly repo: string;
  readonly workspace: string;
  readonly env: Record<string, string>;
  readonly mcsHome: string;
  readonly demo: DemoResult;
  readonly started: StartedInstance;
  readonly mcs: (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function isSettled(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return false;
  return body.files.every(
    (file: unknown) =>
      typeof file === 'object' &&
      file !== null &&
      'behindBytes' in file &&
      file.behindBytes === 0 &&
      'state' in file &&
      file.state === 'active',
  );
}

async function startLive(): Promise<Live> {
  const root = temp.path;
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? path.join(root, 'mcs-home');
  for (const dir of [mcsHome, env['HOME'] ?? path.join(root, 'home')]) mkdirSync(dir, { recursive: true });
  const demo = await buildDemo({ root, nowMs: Date.now() - 60 * 60_000 });
  // a ninth session whose transcript is large, to prove the cap on a result
  const big = new TranscriptBuilder({ sessionId: BIG_SESSION, cwd: demo.repo, startMs: Date.now() - 30 * 60_000 });
  for (let i = 0; i < 60; i += 1) {
    big.user(`FIXTURE big prompt ${String(i)} ${'w'.repeat(4000)}`);
    big.assistant({ messageId: `msg_fixture_mcp_${String(i)}`, text: `FIXTURE big answer ${String(i)}` });
  }
  big.write(path.join(demo.projectDir, `${BIG_SESSION}.jsonl`));
  const mcs: Live['mcs'] = (args) => runCli([...args, '--repo', demo.repo], { mcsHome, env });
  const seed = {
    ...Object.fromEntries(
      Object.entries(demo.configJson).filter(
        ([key]) => !['limits', 'poll', 'docker', 'watched_processes'].includes(key),
      ),
    ),
    panels: { machine: false, git: false, logs: false, ledger: false, chain_log: false, attempts: false },
  };
  const seedFile = path.join(root, 'mcpint.seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const port = await allocatePort();
  const init = await mcs(['init', '--name', 'MCP int', '--slug', SLUG, '--port', String(port), '--config', seedFile]);
  if (init.code !== 0) throw new Error(`init exit ${String(init.code)}: ${init.stderr || init.stdout}`);
  const started = await startInstance({ repo: demo.repo, slug: SLUG, env }, { port });
  const get = async (urlPath: string): Promise<{ status: number; body: unknown }> => {
    const reply = await httpRequest(port, urlPath);
    try {
      return { status: reply.status, body: JSON.parse(reply.body) };
    } catch {
      return { status: reply.status, body: reply.body };
    }
  };
  await waitFor(
    async () => {
      const reply = await get(`${routes.listSessions.path}?limit=100&range=all&includeUnmatched=1`);
      const page = routes.listSessions.response.safeParse(reply.body);
      return reply.status === 200 && page.success && page.data.items.length >= LETTERS.length + 1;
    },
    { what: 'nine sessions in the list', timeoutMs: 90_000, intervalMs: 250 },
  );
  await waitFor(
    async () => {
      for (const id of [...LETTERS.map((l) => demo.sessions[l].sessionId), BIG_SESSION]) {
        const reply = await get(`/api/v3/sessions/${id}`);
        if (reply.status !== 200 || !isSettled(reply.body)) return false;
      }
      return true;
    },
    { what: 'every transcript file imported', timeoutMs: 90_000, intervalMs: 250 },
  );
  let lastHead = -1;
  let quietSince = Date.now();
  await waitFor(
    async () => {
      const reply = await get(`${routes.listSessions.path}?limit=1`);
      const head = routes.listSessions.response.safeParse(reply.body);
      if (!head.success) return false;
      if (head.data.asOfSeq !== lastHead) {
        lastHead = head.data.asOfSeq;
        quietSince = Date.now();
      }
      return Date.now() - quietSince >= 2500;
    },
    { what: 'the change log to be quiet', timeoutMs: 60_000, intervalMs: 300 },
  );
  return {
    repo: demo.repo,
    workspace: path.join(demo.repo, '.claude', 'monitor', 'tasks', SLUG),
    env,
    mcsHome,
    demo,
    started,
    mcs,
  };
}

let live: Live;
const idOf = (letter: DemoLetter): string => live.demo.sessions[letter].sessionId;
const serverArgs = (...extra: string[]): string[] => ['--task', SLUG, '--repo', live.repo, ...extra];
const open = (...extra: string[]): RawMcp => new RawMcp(serverArgs(...extra), live.env);

/** Runs `body` with a started and initialized server and always closes it; returns the closing result. */
async function withServer(
  extra: string[],
  body: (server: RawMcp) => Promise<void>,
  env: Record<string, string> = live.env,
): Promise<void> {
  const server = new RawMcp(serverArgs(...extra), env);
  try {
    await server.initialize();
    await body(server);
  } finally {
    const closed = await server.close();
    expect(closed.code, server.stderr).toBe(0);
    server.assertPureStdout();
  }
}

function expectEnvelope(reply: ToolReply): Envelope {
  expect(reply.isError, reply.text.slice(0, 300)).toBe(false);
  expect(reply.rpc.result?.['content']).toHaveLength(1);
  expect(reply.envelope.kind).toBe('mcs.mcp/1');
  expect(reply.envelope.readOnly).toBe(true);
  expect(reply.envelope.dataNotice).toContain(NOTICE_START);
  expect(typeof reply.envelope.truncated).toBe('boolean');
  expect(Buffer.byteLength(reply.text, 'utf8')).toBeLessThanOrEqual(48 * 1024);
  return reply.envelope;
}

/** The text of the transcript that no metadata tool may return. */
function expectNoTranscriptText(text: string): void {
  for (const secret of [FINAL_A, TOOL_A, PROMPT_A]) expect(text).not.toContain(secret);
}

// Each test spawns real processes at about a second apiece, so the 10 s project default is too short.
describe('mcs mcp over a real instance', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    live = await startLive();
  }, 300_000);
  afterAll(async () => {
    await killAllTracked();
    temp.remove();
  });

  describe('the handshake', () => {
    it.each(['2024-11-05', '2025-06-18', '2025-11-25'])(
      'answers protocol version %s with the same version',
      async (version) => {
        const server = open();
        try {
          const reply = await server.initialize(version);
          expect(reply.error).toBeUndefined();
          expect(reply.result?.['protocolVersion']).toBe(version);
          expect(reply.result?.['serverInfo']).toMatchObject({ name: 'mcs' });
          expect(reply.result?.['capabilities']).toEqual({ tools: {} });
          expect(String(reply.result?.['instructions'])).toContain(NOTICE_START);
          expect(String(reply.result?.['instructions'])).toMatch(/Read-only/);
        } finally {
          expect((await server.close()).code).toBe(0);
          server.assertPureStdout();
        }
      },
    );

    it('answers a client that claims the 2026-07-28 revision with a version the server supports', async () => {
      const server = open();
      try {
        const reply = await server.initialize('2026-07-28');
        expect(reply.error).toBeUndefined();
        expect(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']).toContain(reply.result?.['protocolVersion']);
      } finally {
        expect((await server.close()).code).toBe(0);
      }
    });

    it('serves a client that never sends the initialized notification', async () => {
      const server = open();
      try {
        await server.initialize('2025-06-18', false);
        const list = await server.request('tools/list');
        expect((list.result?.['tools'] as unknown[]).length).toBe(METADATA_TOOLS.length);
        expect((await server.request('ping')).error).toBeUndefined();
      } finally {
        expect((await server.close()).code).toBe(0);
      }
    });

    it('lists the documented tools with read-only annotations, and the three transcript tools only with --include-text', async () => {
      for (const [extra, names] of [
        [[], METADATA_TOOLS],
        [['--include-text'], [...METADATA_TOOLS, ...TEXT_TOOLS]],
      ] as const) {
        await withServer([...extra], async (server) => {
          const list = await server.request('tools/list');
          const tools = list.result?.['tools'] as {
            name: string;
            description: string;
            inputSchema: { type: string; additionalProperties: boolean };
            annotations: Record<string, boolean>;
          }[];
          expect(tools.map((t) => t.name)).toEqual(names);
          for (const tool of tools) {
            expect(tool.annotations).toEqual({
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            });
            expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
            expect(tool.description.length).toBeGreaterThan(20);
          }
        });
      }
    });
  });

  describe('the metadata tools while the instance runs (API mode)', () => {
    it('every tool answers with the envelope, the data notice and no transcript text', async () => {
      await withServer([], async (server) => {
        const status = expectEnvelope(await server.call('mcs_instance_status'));
        expect(status.data).toMatchObject({ running: true, state: 'running', task: { id: SLUG } });

        const overview = expectEnvelope(await server.call('mcs_overview', { range: 'all' }));
        expect(overview.data).toHaveProperty('metrics');
        expect(overview.asOfSeq).toEqual(expect.any(Number));

        const list = expectEnvelope(await server.call('mcs_list_sessions', { all: true, limit: 50 }));
        const items = (list.data as { items: { id: string; label: string; state: string }[] }).items;
        for (const letter of LETTERS) {
          expect(
            items.find((s) => s.id === idOf(letter)),
            letter,
          ).toMatchObject({ label: `build step ${letter}` });
        }
        expect(list.asOfSeq).toEqual(expect.any(Number));

        const one = expectEnvelope(await server.call('mcs_get_session', { session: idOf('A').slice(0, 8), events: 5 }));
        expect(one.data).toMatchObject({ session: { id: idOf('A'), label: 'build step A' } });
        expect(JSON.stringify(one.data)).toContain('Bash');

        for (const by of ['model', 'session', 'day', 'tool'] as const) {
          const usage = expectEnvelope(await server.call('mcs_usage', { by, since: 'all' }));
          expect(usage.data).toMatchObject({ by });
        }
        expectEnvelope(await server.call('mcs_errors', { limit: 5 }));
        expectEnvelope(await server.call('mcs_alerts', { status: 'open' }));
        const verify = expectEnvelope(await server.call('mcs_verify_completion', { session: idOf('A') }));
        expect(verify.data).toMatchObject({ sessionId: idOf('A') });
        expect(['completed', 'failed', 'not_terminal']).toContain((verify.data as { outcome: string }).outcome);

        expectNoTranscriptText(server.stdoutText);
      });
    });

    it('refuses an argument that is not valid with a fixed message that does not repeat the value', async () => {
      await withServer([], async (server) => {
        const secret = 'SECRET-ARGUMENT-VALUE-77';
        for (const [tool, args] of [
          ['mcs_list_sessions', { limit: 500 }],
          ['mcs_list_sessions', { limit: secret }],
          ['mcs_list_sessions', { [secret]: 1 }],
          ['mcs_get_session', {}],
          ['mcs_get_session', { session: `../../${secret}` }],
          ['mcs_usage', { by: secret }],
          ['mcs_errors', { source: 'x'.repeat(1_000_000) }],
          ['mcs_verify_completion', { session: idOf('A'), label: 'x' }],
        ] as const) {
          const reply = await server.call(tool, args);
          expect(reply.isError, `${tool} ${JSON.stringify(args).slice(0, 80)}`).toBe(true);
          expect(reply.envelope.error?.code).toBe('invalid_arguments');
          expect(reply.envelope.data).toBeNull();
          expect(reply.envelope.dataNotice).toContain(NOTICE_START);
          expect(reply.text).not.toContain(secret);
          expect(reply.text.length).toBeLessThan(600);
        }
        // a value the route itself refuses (not the schema of the tool) is a catalogue error too
        const since = await server.call('mcs_list_sessions', { since: secret });
        expect(since.isError).toBe(true);
        expect(since.envelope.error?.code).toBe('validation_failed');
        expect(since.text).not.toContain(secret);
        const missing = await server.call('mcs_get_session', { session: 'deadbeef' });
        expect(missing.isError).toBe(true);
        expect(missing.envelope.error?.code).toBe('session_not_found');
      });
    });

    it('answers an unknown tool, a write-like name and a transcript tool without --include-text with a protocol error', async () => {
      await withServer([], async (server) => {
        for (const name of [
          'mcs_stop',
          'mcs_start',
          'mcs_restart',
          'mcs_export',
          'mcs_delete_session',
          'nope',
          'mcs_read_transcript',
        ]) {
          const rpc = await server.request('tools/call', { name, arguments: {} });
          expect(rpc.result, name).toBeUndefined();
          expect(rpc.error?.code, name).toBe(-32602);
          expect(rpc.error?.message, name).not.toContain(name);
        }
        const other = await server.request('resources/list');
        expect(other.error).toBeDefined();
        const prompts = await server.request('prompts/list');
        expect(prompts.error).toBeDefined();
      });
    });

    it('answers 1,000 requests in a row, then still serves a tool call', async () => {
      await withServer([], async (server) => {
        const started = performance.now();
        for (let batch = 0; batch < 10; batch += 1) {
          const replies = await Promise.all(
            Array.from({ length: 100 }, (_v, i) => server.request(i % 2 === 0 ? 'ping' : 'tools/list')),
          );
          expect(replies.every((r) => r.error === undefined)).toBe(true);
        }
        expect(performance.now() - started).toBeLessThan(60_000 * PERF);
        expectEnvelope(await server.call('mcs_instance_status'));
      });
    });

    it('keeps stdout to JSON-RPC lines after an error and with MCS_DEBUG=1', async () => {
      await withServer(
        [],
        async (server) => {
          await server.request('tools/call', { name: 'nope', arguments: {} });
          expect((await server.call('mcs_get_session', {})).isError).toBe(true);
          server.child.stdin.write('this is not json\n');
          expectEnvelope(await server.call('mcs_instance_status'));
        },
        { ...live.env, MCS_DEBUG: '1' },
      );
    });
  });

  describe('--include-text', () => {
    it('searches and reads transcript text, labelled as data, with an escaped hostile string', async () => {
      await withServer(['--include-text'], async (server) => {
        const one = expectEnvelope(await server.call('mcs_search_transcript', { session: idOf('A'), q: 'unit tests' }));
        expect(JSON.stringify(one.data)).toContain('FIXTURE');
        const all = expectEnvelope(
          await server.call('mcs_search_transcripts', { q: 'FIXTURE', range: 'all', limit: 10 }),
        );
        expect(JSON.stringify(all.data)).toContain('FIXTURE');
        const read = expectEnvelope(await server.call('mcs_read_transcript', { session: idOf('A'), limit: 50 }));
        expect(JSON.stringify(read.data)).toContain(FINAL_A);

        const hostile = await server.call('mcs_read_transcript', { session: idOf('H'), limit: 50 });
        expectEnvelope(hostile);
        // no raw escape or bidi character reaches the wire: they are text (a backslash, u and four hex digits, with the backslash doubled in the frame)
        expect(server.stdoutText).not.toContain(ESC);
        expect(server.stdoutText).not.toContain(RLO);
        expect(hostile.text).toContain('\\u202e');
        expect(hostile.text).toContain('\\u001b');
        // and it is the real character once the JSON is parsed
        expect(JSON.stringify(hostile.envelope.data)).toContain(RLO);
      });
    });

    it('cuts a result above 48 KiB, says so, and the cut stays valid JSON', async () => {
      await withServer(['--include-text'], async (server) => {
        const reply = await server.call('mcs_read_transcript', { session: BIG_SESSION, limit: 50, textChars: 5000 });
        expect(reply.isError).toBe(false);
        expect(reply.envelope.truncated).toBe(true);
        expect(reply.envelope.hint).toMatch(/narrow the request/);
        expect(Buffer.byteLength(reply.text, 'utf8')).toBeLessThanOrEqual(48 * 1024);
        expect(reply.envelope.dataNotice).toContain(NOTICE_START);
        const small = expectEnvelope(
          await server.call('mcs_read_transcript', { session: BIG_SESSION, limit: 2, textChars: 200 }),
        );
        expect(small.truncated).toBe(false);
      });
    });

    it('refuses a short search text and a session id that is not a full id', async () => {
      await withServer(['--include-text'], async (server) => {
        expect((await server.call('mcs_search_transcripts', { q: 'a' })).isError).toBe(true);
        expect((await server.call('mcs_read_transcript', { session: idOf('A').slice(0, 8) })).isError).toBe(true);
        expect((await server.call('mcs_read_transcript', { session: idOf('A'), limit: 51 })).isError).toBe(true);
      });
    });
  });

  describe('process behaviour', () => {
    it('exits 0 within 100 ms after stdin closes, and also when it never got a message', async () => {
      const times: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const server = open();
        await server.initialize();
        await server.call('mcs_instance_status');
        const closed = await server.close();
        expect(closed.code, server.stderr).toBe(0);
        times.push(closed.ms);
      }
      times.sort((a, b) => a - b);
      expect(times[1], times.join(', ')).toBeLessThanOrEqual(100 * PERF);
      const silent = open();
      const closed = await silent.close();
      expect(closed.code, silent.stderr).toBe(0);
      expect(silent.stdoutLines).toEqual([]);
    });

    it('exits 0 when the client closes stdin in the middle of a call', async () => {
      const server = open('--include-text');
      await server.initialize();
      server.send({
        id: 99,
        method: 'tools/call',
        params: { name: 'mcs_search_transcripts', arguments: { q: 'FIXTURE', range: 'all' } },
      });
      const closed = await server.close();
      expect(closed.code, server.stderr).toBe(0);
      server.assertPureStdout();
    });

    it('refuses --json without --print-config and a task that does not exist, with nothing on stdout from the server', async () => {
      const json = await live.mcs(['mcp', '--task', SLUG, '--json']);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
      const missing = await live.mcs(['mcp', '--task', 'nope']);
      expect(missing.code).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('no task.json');
      const noTask = await live.mcs(['mcp']);
      expect(noTask.code).toBe(2);
      expect(noTask.stderr).toContain('--task');
    });
  });

  describe('--print-config', () => {
    it('prints a command and a .mcp.json entry that parse, and changes nothing', async () => {
      const before = snapshotTree(live.repo);
      const text = await live.mcs(['mcp', '--task', SLUG, '--print-config']);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain('claude mcp add --transport stdio mcs-mcpint --');
      expect(text.stdout).toContain('"mcpServers"');
      const json = await live.mcs(['mcp', '--task', SLUG, '--print-config', '--include-text', '--json']);
      expect(json.code, json.stderr).toBe(0);
      const data = McpConfigResultSchema.parse((JSON.parse(json.stdout) as { data: unknown }).data);
      expect(data).toMatchObject({ task: SLUG, serverName: `mcs-${SLUG}`, includeText: true });
      const args = data.mcpJson.mcpServers[`mcs-${SLUG}`]?.args ?? [];
      expect(args.slice(1)).toEqual([
        'mcp',
        '--task',
        SLUG,
        '--include-text',
        '--repo',
        live.repo.split(path.sep).join('/'),
      ]);
      expect(snapshotTree(live.repo)).toBe(before);
    });

    it('writes a command for a repository path with a space that survives a shell tokenizer', async () => {
      const root = path.join(temp.path, 'path with space', 'my repo');
      const { repo } = buildRepo(root);
      buildTaskWorkspace(repo, { slug: 'spacey', config: {} });
      const run = await runCli(['mcp', '--task', 'spacey', '--print-config', '--json', '--repo', repo], {
        mcsHome: live.mcsHome,
        env: live.env,
      });
      expect(run.code, run.stderr).toBe(0);
      const data = McpConfigResultSchema.parse((JSON.parse(run.stdout) as { data: unknown }).data);
      const words = tokenize(data.command);
      expect(words.slice(0, 7)).toEqual(['claude', 'mcp', 'add', '--transport', 'stdio', 'mcs-spacey', '--']);
      expect(words.slice(7)).toEqual(['node', ...(data.mcpJson.mcpServers['mcs-spacey']?.args ?? [])]);
      expect(words[words.length - 1]).toBe(repo.split(path.sep).join('/'));
      const bad = await runCli(['mcp', '--task', 'has space', '--print-config', '--repo', repo], {
        mcsHome: live.mcsHome,
        env: live.env,
      });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('invalid task slug');
    });
  });

  describe('the instance stops while the server runs, and the stopped database', () => {
    it('re-probes on the next call and answers the same sessions from the database, writing nothing', async () => {
      const server = open();
      await server.initialize();
      try {
        const running = expectEnvelope(await server.call('mcs_instance_status'));
        expect(running.data).toMatchObject({ running: true, state: 'running' });
        const listed = expectEnvelope(await server.call('mcs_list_sessions', { all: true, limit: 50 }));
        const fromApi = (listed.data as { items: { id: string; label: string; state: string }[] }).items;
        const apiIds = fromApi.map((s) => s.id).sort();

        await live.started.stop();
        const tree = snapshotTree(live.workspace, { exclude: ['data/monitor.db-shm'] });

        const stopped = expectEnvelope(await server.call('mcs_instance_status'));
        expect(stopped.data).toMatchObject({ running: false, state: 'stopped' });
        const again = expectEnvelope(await server.call('mcs_list_sessions', { all: true, limit: 50 }));
        const fromDb = (again.data as { items: { id: string; label: string; state: string }[] }).items;
        expect(fromDb.map((s) => s.id).sort()).toEqual(apiIds);
        expect(fromDb.map((s) => `${s.id}:${s.label}`).sort()).toEqual(fromApi.map((s) => `${s.id}:${s.label}`).sort());

        // every tool, on the database
        for (const [name, args] of [
          ['mcs_overview', { range: 'all' }],
          ['mcs_get_session', { session: idOf('A') }],
          ['mcs_usage', { by: 'session', since: 'all' }],
          ['mcs_usage', { by: 'tool', since: 'all' }],
          ['mcs_usage', { by: 'day', since: 'all' }],
          ['mcs_errors', {}],
          ['mcs_alerts', {}],
          ['mcs_verify_completion', { session: idOf('A') }],
        ] as const) {
          expectEnvelope(await server.call(name, args));
        }
        expectNoTranscriptText(server.stdoutText);
        expect(snapshotTree(live.workspace, { exclude: ['data/monitor.db-shm'] })).toBe(tree);
      } finally {
        expect((await server.close()).code).toBe(0);
        server.assertPureStdout();
      }
    });

    it('serves the transcript tools from the database and leaves the workspace byte for byte the same', async () => {
      const tree = snapshotTree(live.workspace, { exclude: ['data/monitor.db-shm'] });
      await withServer(['--include-text'], async (server) => {
        const read = expectEnvelope(await server.call('mcs_read_transcript', { session: idOf('A'), limit: 50 }));
        expect(JSON.stringify(read.data)).toContain(FINAL_A);
        expectEnvelope(await server.call('mcs_search_transcript', { session: idOf('A'), q: 'FIXTURE' }));
        expectEnvelope(await server.call('mcs_search_transcripts', { q: 'FIXTURE', range: 'all' }));
        expectEnvelope(await server.call('mcs_get_session', { session: idOf('H'), events: 20 }));
      });
      expect(snapshotTree(live.workspace, { exclude: ['data/monitor.db-shm'] })).toBe(tree);
    });

    it('says clearly that a task that never ran has no database yet', async () => {
      const made = await live.mcs([
        'init',
        '--name',
        'Never ran',
        '--slug',
        'never',
        '--port',
        String(await allocatePort()),
      ]);
      expect(made.code, made.stderr).toBe(0);
      const server = new RawMcp(['--task', 'never', '--repo', live.repo], live.env);
      try {
        await server.initialize();
        const reply = await server.call('mcs_list_sessions');
        expect(reply.isError).toBe(true);
        expect(reply.envelope.error?.code).toBe('DB_ERROR');
        expect(reply.envelope.error?.message).toMatch(/mcs start/);
      } finally {
        expect((await server.close()).code).toBe(0);
        server.assertPureStdout();
      }
    });
  });
});

/** A POSIX-shell tokenizer for what `formatCommand` produces: words and double quotes with backslash escapes. */
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
