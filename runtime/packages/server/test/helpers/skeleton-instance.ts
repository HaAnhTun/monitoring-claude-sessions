// Harness of the API-level walking-skeleton smoke (LF-5): a real instance started through the real CLI, fed by a small
// synthetic transcript tree, and the values the API must report, computed here by a deliberately naive calculation that
// reads the fixture files back from disk (it shares no code with the engine). Everything below is clearly labelled FIXTURE
// data; nothing is read from a real Claude home, and every process, port and folder is removed by `stop()`.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { StateFileSchema, routes } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  buildClaudeHome,
  httpRequest,
  makeTempDir,
  runCli,
  waitFor,
  type PortRange,
  type SessionSpec,
  type TranscriptBuilder,
} from '@mcs/testkit';
import { z } from 'zod';

// ---- the fixture ---------------------------------------------------------------------------------------------------------

/** FIXTURE ids: uuid-shaped and obviously synthetic. */
export const FIXTURE_SESSION_A = 'f1f1f1f1-0000-4000-8000-00000000000a';
export const FIXTURE_SESSION_B = 'f1f1f1f1-0000-4000-8000-00000000000b';
export const FIXTURE_AGENT_A = 'agentfixture0001';
const PROJECT = '-FIXTURE-skeleton-project';
const SLUG = 'skeleton';
const LABEL_A = 'Skeleton alpha';
const LABEL_B = 'Skeleton beta';

/** Age of the newest write of each fixture session, in ms before the harness started. */
const AGE_A_MS = 20 * 60_000;
const AGE_B_MS = 330_000;

const USAGE_A1 = {
  input_tokens: 11,
  output_tokens: 60,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
};
const USAGE_A2 = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 1100, cache_creation_input_tokens: 30 };
const USAGE_SUB = { input_tokens: 5, output_tokens: 90, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 };
const USAGE_B1 = {
  input_tokens: 21,
  output_tokens: 40,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 300,
};

function buildSessionA(b: TranscriptBuilder): void {
  b.user('FIXTURE alpha: list the files');
  // One streamed message in three snapshots (the output grows), then its tool_use block as a second record that repeats
  // the message id and the usage: both must be counted once.
  b.assistant({
    messageId: 'msg_fixture_alpha_1',
    usage: USAGE_A1,
    snapshots: 3,
    outputPerRecord: [5, 20, 60],
    stop: null,
  });
  const bash = b.toolUse(
    'Bash',
    { command: 'echo FIXTURE alpha' },
    { messageId: 'msg_fixture_alpha_1', usage: USAGE_A1 },
  );
  b.toolResult(bash, { content: 'FIXTURE alpha output ok' });
  const read = b.toolUse(
    'Read',
    { description: 'FIXTURE read' },
    { messageId: 'msg_fixture_alpha_2', usage: USAGE_A2 },
  );
  b.toolResult(read, { content: 'FIXTURE read failed', isError: true });
  b.turnEnd();
}

function buildSubagentA(b: TranscriptBuilder): void {
  b.user('FIXTURE alpha subagent task');
  b.assistant({
    messageId: 'msg_fixture_sub_1',
    usage: USAGE_SUB,
    snapshots: 2,
    outputPerRecord: [10, 90],
    stop: null,
  });
  const grep = b.toolUse('Grep', { description: 'FIXTURE grep' }, { messageId: 'msg_fixture_sub_1', usage: USAGE_SUB });
  b.toolResult(grep, { content: 'FIXTURE grep output ok' });
  b.turnEnd();
}

function buildSessionB(b: TranscriptBuilder): void {
  b.user('FIXTURE beta: run the build');
  b.assistant({
    messageId: 'msg_fixture_beta_1',
    usage: USAGE_B1,
    snapshots: 2,
    outputPerRecord: [12, 40],
    stop: null,
  });
  // The tool call has no result: the session is in a turn with one open tool.
  b.toolUse('Bash', { command: 'echo FIXTURE beta' }, { messageId: 'msg_fixture_beta_1', usage: USAGE_B1 });
}

function sessionSpecs(nowMs: number): SessionSpec[] {
  return [
    {
      id: FIXTURE_SESSION_A,
      project: PROJECT,
      build: buildSessionA,
      mtimeAgeMs: AGE_A_MS,
      subagents: [
        {
          agentId: FIXTURE_AGENT_A,
          meta: { agentType: 'general-purpose', description: 'FIXTURE subagent' },
          build: buildSubagentA,
        },
      ],
    },
    {
      id: FIXTURE_SESSION_B,
      project: PROJECT,
      build: buildSessionB,
      mtimeAgeMs: AGE_B_MS,
      startMs: nowMs - AGE_B_MS - 5_000,
    },
  ];
}

// ---- the expected values: a naive calculation over the files on disk -------------------------------------------------------

export interface ExpectedUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
  readonly total: number;
  /** Distinct message ids. */
  readonly turns: number;
}

export interface ExpectedToolCall {
  readonly toolUseId: string;
  readonly name: string;
  /** `null` while the call has no result. */
  readonly resultText: string | null;
  readonly isError: boolean | null;
  /** `main`, or the id of the subagent whose file holds the call. */
  readonly agentId: string;
}

export interface ExpectedSession {
  readonly id: string;
  readonly label: string;
  /** From the decision table 02 7.4: A ended its turn (S-8e), B is in a turn with an open tool younger than 900 s (S-7c). */
  readonly state: 'turn_ended' | 'waiting_tool';
  readonly pendingTools: number;
  readonly own: ExpectedUsage;
  readonly inclSubagents: ExpectedUsage;
  readonly toolCalls: readonly ExpectedToolCall[];
  readonly agentCount: number;
  /** Transcript files of the session (main plus subagents). */
  readonly fileCount: number;
}

export interface SkeletonExpected {
  readonly sessions: readonly [ExpectedSession, ExpectedSession];
}

const UsageLine = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({
    id: z.string().min(1),
    usage: z.looseObject({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number(),
      cache_creation_input_tokens: z.number(),
    }),
    content: z.array(z.looseObject({ type: z.string(), id: z.string().optional(), name: z.string().optional() })),
  }),
});

const ResultLine = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({
    content: z.array(
      z.looseObject({
        type: z.string(),
        tool_use_id: z.string().optional(),
        content: z.unknown().optional(),
        is_error: z.boolean().optional(),
      }),
    ),
  }),
});

interface Tally {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

function linesOf(file: string): unknown[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): unknown => JSON.parse(line));
}

/** Dedupe by `message.id`, the largest value of each counter wins, then sum (the counting rule of 02 6.3, done naively). */
function naiveUsage(files: readonly string[]): ExpectedUsage {
  const perMessage = new Map<string, Tally>();
  for (const file of files) {
    for (const line of linesOf(file)) {
      const parsed = UsageLine.safeParse(line);
      if (!parsed.success) continue;
      const { id, usage } = parsed.data.message;
      const seen = perMessage.get(id) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      perMessage.set(id, {
        input: Math.max(seen.input, usage.input_tokens),
        output: Math.max(seen.output, usage.output_tokens),
        cacheCreation: Math.max(seen.cacheCreation, usage.cache_creation_input_tokens),
        cacheRead: Math.max(seen.cacheRead, usage.cache_read_input_tokens),
      });
    }
  }
  const sum: Tally = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const t of perMessage.values()) {
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheCreation += t.cacheCreation;
    sum.cacheRead += t.cacheRead;
  }
  return { ...sum, total: sum.input + sum.output + sum.cacheCreation + sum.cacheRead, turns: perMessage.size };
}

function naiveToolCalls(file: string, agentId: string): ExpectedToolCall[] {
  const names = new Map<string, string>();
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const line of linesOf(file)) {
    const assistant = UsageLine.safeParse(line);
    if (assistant.success) {
      for (const block of assistant.data.message.content) {
        if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
          names.set(block.id, block.name);
        }
      }
    }
    const user = ResultLine.safeParse(line);
    if (user.success) {
      for (const block of user.data.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id !== undefined && typeof block.content === 'string') {
          results.set(block.tool_use_id, { text: block.content, isError: block.is_error === true });
        }
      }
    }
  }
  return [...names].map(([toolUseId, name]) => {
    const result = results.get(toolUseId);
    return { toolUseId, name, resultText: result?.text ?? null, isError: result?.isError ?? null, agentId };
  });
}

function jsonlFilesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonlFilesBelow(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** `agent-<id>.jsonl` names the agent whose records the file holds. */
function agentIdOfFile(file: string): string {
  const name = basename(file);
  if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) throw new Error(`not a subagent file: ${file}`);
  return name.slice('agent-'.length, -'.jsonl'.length);
}

function expectedOf(
  projectDir: string,
  id: string,
  label: string,
  state: ExpectedSession['state'],
  pendingTools: number,
): ExpectedSession {
  const main = join(projectDir, `${id}.jsonl`);
  const subagentFiles = jsonlFilesBelow(join(projectDir, id));
  return {
    id,
    label,
    state,
    pendingTools,
    own: naiveUsage([main]),
    inclSubagents: naiveUsage([main, ...subagentFiles]),
    toolCalls: [
      ...naiveToolCalls(main, 'main'),
      ...subagentFiles.flatMap((file) => naiveToolCalls(file, agentIdOfFile(file))),
    ],
    agentCount: 1 + subagentFiles.length,
    fileCount: 1 + subagentFiles.length,
  };
}

// ---- the instance --------------------------------------------------------------------------------------------------------

const DEFAULT_PORT_RANGE: PortRange = [18000, 18499];

export interface SkeletonOptions {
  /** Budget of the wait for the importer, in ms (default 60 000). */
  readonly importTimeoutMs?: number;
  /** Inclusive range the instance port is allocated from (default `[18000, 18499]`, the Vitest range of plan 3.2). */
  readonly portRange?: PortRange;
}

export interface SkeletonInstance {
  readonly baseUrl: string;
  readonly port: number;
  readonly repoDir: string;
  readonly instanceDir: string;
  readonly expected: SkeletonExpected;
  /** `GET <path>` with the right Host; the body is parsed JSON (the raw text when it is not JSON). */
  getJson(path: string): Promise<{ status: number; body: unknown }>;
  stop(): Promise<void>;
}

/** An error that names the step of the harness that failed. */
export class SkeletonStepError extends Error {
  readonly step: string;
  constructor(step: string, detail: string) {
    super(`skeleton step '${step}' failed: ${detail}`);
    this.name = 'SkeletonStepError';
    this.step = step;
  }
}

function describeCli(result: { code: number; stdout: string; stderr: string }): string {
  const text = (result.stderr.trim() || result.stdout.trim()).slice(0, 600);
  return `exit ${String(result.code)}: ${text}`;
}

const SessionIds = z.object({ items: z.array(z.looseObject({ id: z.string() })) });
const Files = z.object({ files: z.array(z.looseObject({ behindBytes: z.number(), state: z.string() })) });

export async function startSkeletonInstance(options: SkeletonOptions = {}): Promise<SkeletonInstance> {
  const importTimeoutMs = options.importTimeoutMs ?? 60_000;
  const portRange = options.portRange ?? DEFAULT_PORT_RANGE;
  const root = makeTempDir('skeleton');
  let started = false;
  let stopped = false;
  let port = 0;
  let repoDir = '';
  let claudeDir = '';
  let mcsHome = '';

  const cli = (args: readonly string[]): ReturnType<typeof runCli> =>
    runCli(args, { mcsHome, env: { CLAUDE_CONFIG_DIR: claudeDir } });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const failures: string[] = [];
    try {
      if (started) {
        const result = await cli(['stop', '--task', SLUG, '--repo', repoDir]);
        if (result.code !== 0) failures.push(`stop ${describeCli(result)}`);
      }
      if (port !== 0) await assertPortClosed(port);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      root.remove();
    }
    if (failures.length > 0) throw new SkeletonStepError('stop', failures.join('; '));
  };

  const step = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SkeletonStepError) throw error;
      throw new SkeletonStepError(name, error instanceof Error ? error.message : String(error));
    }
  };

  try {
    mcsHome = join(root.path, 'mcs-home');
    claudeDir = join(root.path, 'claude-home');
    repoDir = join(root.path, 'repo');
    await step('create-dirs', () => {
      for (const dir of [mcsHome, claudeDir, repoDir]) mkdirSync(dir, { recursive: true });
    });
    const nowMs = Date.now();
    await step('build-fixture', () => {
      buildClaudeHome(claudeDir, { sessions: sessionSpecs(nowMs), nowMs });
    });
    const projectDir = join(claudeDir, 'projects', PROJECT);
    const wanted = await step('allocate-port', () => allocatePort(portRange));
    const instanceDir = join(repoDir, '.claude', 'monitor', 'tasks', SLUG);

    await step('init', async () => {
      const result = await cli(['init', '--name', SLUG, '--slug', SLUG, '--repo', repoDir, '--port', String(wanted)]);
      if (result.code !== 0) throw new Error(describeCli(result));
    });
    await step('configure', async () => {
      const rules = [
        { match: 'FIXTURE alpha', label: LABEL_A },
        { match: 'FIXTURE beta', label: LABEL_B },
      ];
      const result = await cli([
        'configure',
        '--task',
        SLUG,
        '--repo',
        repoDir,
        '--set',
        `transcripts_dir=${JSON.stringify(projectDir)}`,
        '--set',
        `session_rules=${JSON.stringify(rules)}`,
        '--reason',
        'skeleton smoke fixture',
      ]);
      if (result.code !== 0) throw new Error(describeCli(result));
    });
    await step('start', async () => {
      const result = await cli(['start', '--task', SLUG, '--repo', repoDir, '--port', String(wanted)]);
      started = true;
      if (result.code !== 0) throw new Error(describeCli(result));
    });
    await step('state-file', () => {
      const state = StateFileSchema.parse(JSON.parse(readFileSync(join(instanceDir, 'state.json'), 'utf8')));
      port = state.port;
    });

    const get = async (path: string): Promise<{ status: number; body: unknown }> => {
      const reply = await httpRequest(port, path);
      let body: unknown;
      try {
        body = JSON.parse(reply.body);
      } catch {
        body = reply.body;
      }
      return { status: reply.status, body };
    };

    await step('health', async () => {
      await waitFor(async () => (await get(routes.health.path)).status === 200, {
        what: `GET ${routes.health.path} answers 200 on port ${String(port)}`,
        timeoutMs: 20_000,
        intervalMs: 100,
      });
    });
    await step('import-sessions', async () => {
      await waitFor(
        async () => {
          const reply = await get(routes.listSessions.path);
          if (reply.status !== 200) return false;
          const ids = SessionIds.parse(reply.body).items.map((item) => item.id);
          return ids.includes(FIXTURE_SESSION_A) && ids.includes(FIXTURE_SESSION_B);
        },
        { what: 'both fixture sessions in the session list', timeoutMs: importTimeoutMs, intervalMs: 200 },
      );
    });
    const expected: SkeletonExpected = {
      sessions: [
        expectedOf(projectDir, FIXTURE_SESSION_A, LABEL_A, 'turn_ended', 0),
        expectedOf(projectDir, FIXTURE_SESSION_B, LABEL_B, 'waiting_tool', 1),
      ],
    };
    await step('settle', async () => {
      await waitFor(
        async () => {
          for (const session of expected.sessions) {
            const reply = await get(`/api/v3/sessions/${session.id}`);
            if (reply.status !== 200) return false;
            const { files } = Files.parse(reply.body);
            if (files.length !== session.fileCount) return false;
            if (files.some((file) => file.behindBytes !== 0 || file.state !== 'active')) return false;
          }
          return true;
        },
        {
          what: 'every transcript file of both sessions imported (no bytes behind)',
          timeoutMs: importTimeoutMs,
          intervalMs: 200,
        },
      );
    });

    return { baseUrl: `http://127.0.0.1:${String(port)}`, port, repoDir, instanceDir, expected, getJson: get, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
