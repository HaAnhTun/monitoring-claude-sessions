// A real instance on synthetic data for the visual QA tool (WP-122, live mode). It composes the testkit helpers: `buildDemo`
// writes the eight demo sessions (completed, failed, waiting for a tool, turn ended, a long run, a workflow with subagents,
// stale, hostile strings), `buildClaudeHome` adds the sessions the demo lacks (working with fresh activity, working but quiet
// for 25 minutes, a failing subagent, a very long label), the real CLI creates and configures the task (prices, the trend
// chart, three declared work items) and `startInstance` starts it. Everything is FIXTURE data in a temp tree; `stop()` stops the
// instance, asserts that the port is closed and removes the tree. Run it inside the `run` lock (plan section 3).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { routes } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  buildClaudeHome,
  buildDemo,
  hermeticEnv,
  httpRequest,
  makeTempDir,
  runCli,
  startInstance,
  waitFor,
  type DemoLetter,
  type SessionSpec,
  type StartedInstance,
  type TranscriptBuilder,
} from '@mcs/testkit';

/** The ports of the Playwright tools (plan section 3.2). */
export const QA_PORT_RANGE: readonly [number, number] = [18500, 18599];

/** The slug of the task the tool creates. */
export const QA_SLUG = 'qa';

/** Ids of the extra sessions: uuid-shaped and obviously synthetic. */
export const QA_SESSION_FRESH = '9a9a9a9a-0000-4000-8000-000000000001';
export const QA_SESSION_QUIET = '9a9a9a9a-0000-4000-8000-000000000002';
export const QA_SESSION_SUBAGENT_ERROR = '9a9a9a9a-0000-4000-8000-000000000003';
export const QA_SESSION_LONG_LABEL = '9a9a9a9a-0000-4000-8000-000000000004';
export const QA_SESSION_WAITING = '9a9a9a9a-0000-4000-8000-000000000005';
export const QA_SESSION_SILENT = '9a9a9a9a-0000-4000-8000-000000000006';

const MINUTE = 60_000;

/** The label of the session whose label is far longer than any column. */
export const QA_LONG_LABEL =
  'FIXTURE long label: migrate the billing service to the new payment provider, update every integration test and the runbook';

/** Age of the quiet session: inside the working window of 30 minutes, so the engine still calls it working (inferred). */
export const QA_QUIET_AGE_MS = 25 * MINUTE;

/** A synthetic price per million tokens; the numbers are invented and carry no meaning. */
const PRICES = [
  {
    match: '*',
    effectiveFrom: '2026-01-01',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWrite5mPerMTok: 3.75,
    cacheWrite1hPerMTok: 6,
  },
];

const USAGE = {
  input_tokens: 24,
  output_tokens: 310,
  cache_read_input_tokens: 18_000,
  cache_creation_input_tokens: 700,
};

/** Working, observed (S-7b): a tool call opened a few seconds ago. */
function fresh(b: TranscriptBuilder): void {
  b.user('FIXTURE QA fresh: refactor the parser module');
  b.assistant({
    messageId: 'msg_qa_fresh_1',
    text: 'FIXTURE Reading the parser module first.',
    stop: null,
    usage: USAGE,
  });
  const read = b.toolUse('Read', { file_path: 'FIXTURE/parser.ts' }, { messageId: 'msg_qa_fresh_1', usage: USAGE });
  b.toolResult(read, { content: 'FIXTURE parser.ts (310 lines)' });
  b.assistant({ messageId: 'msg_qa_fresh_2', text: 'FIXTURE Applying the change.', stop: null, usage: USAGE });
  b.toolUse('Edit', { file_path: 'FIXTURE/parser.ts' }, { messageId: 'msg_qa_fresh_2', usage: USAGE });
}

/** Waiting for a tool (S-7c): a tool call has been open for five minutes. */
function waitingTool(b: TranscriptBuilder): void {
  b.user('FIXTURE QA waiting: run the end-to-end suite');
  b.assistant({ messageId: 'msg_qa_wait_1', text: 'FIXTURE Starting the suite.', stop: null, usage: USAGE });
  b.toolUse('Bash', { command: 'echo FIXTURE e2e' }, { messageId: 'msg_qa_wait_1', usage: USAGE });
}

/** Working, inferred (S-7e): inside a turn, no open tool, quiet for 25 minutes. */
function quiet(b: TranscriptBuilder): void {
  b.user('FIXTURE QA quiet: investigate the flaky cache test');
  b.assistant({ messageId: 'msg_qa_quiet_1', text: 'FIXTURE Running the test in a loop.', stop: null, usage: USAGE });
  const bash = b.toolUse('Bash', { command: 'echo FIXTURE loop' }, { messageId: 'msg_qa_quiet_1', usage: USAGE });
  b.toolResult(bash, { content: 'FIXTURE 40 runs, 3 failures' });
  b.assistant({ messageId: 'msg_qa_quiet_2', text: 'FIXTURE Narrowing it down.', stop: null, usage: USAGE });
}

/** Stale (S-7f): the same shape as the quiet session, silent for 45 minutes. */
function silent(b: TranscriptBuilder): void {
  b.user('FIXTURE QA silent: migrate the search index');
  b.assistant({ messageId: 'msg_qa_silent_1', text: 'FIXTURE Rebuilding the index.', stop: null, usage: USAGE });
}

/** Turn ended, with one error that belongs to a subagent (the main agent has none). */
function subagentError(b: TranscriptBuilder): void {
  b.user('FIXTURE QA subagent: run the release checklist with helpers');
  b.assistant({
    messageId: 'msg_qa_sub_1',
    text: 'FIXTURE Handing the lint check to a helper.',
    stop: null,
    usage: USAGE,
  });
  const task = b.toolUse('Task', { description: 'FIXTURE lint helper' }, { messageId: 'msg_qa_sub_1', usage: USAGE });
  b.toolResult(task, { content: 'FIXTURE helper reported one failure' });
  b.turnEnd();
}

function subagentErrorHelper(b: TranscriptBuilder): void {
  b.user('FIXTURE Run the lint check');
  b.assistant({ messageId: 'msg_qa_sub_h1', text: 'FIXTURE Linting.', stop: null, usage: USAGE });
  const lint = b.toolUse('Bash', { command: 'echo FIXTURE lint' }, { messageId: 'msg_qa_sub_h1', usage: USAGE });
  b.toolResult(lint, { content: 'FIXTURE 3 problems found', isError: true });
  b.turnEnd();
}

function longLabel(b: TranscriptBuilder): void {
  b.user('FIXTURE QA long label: the billing migration');
  b.assistant({ messageId: 'msg_qa_long_1', text: 'FIXTURE Listing the call sites.', stop: null, usage: USAGE });
  b.turnEnd();
}

/** A transcript builder writes one record per second; the first record is placed so that the last one is `ageMs` old. */
function startFor(nowMs: number, ageMs: number, records: number): number {
  return nowMs - ageMs - (records - 1) * 1000;
}

function extraSessions(projectDir: string, repo: string, nowMs: number): SessionSpec[] {
  const project = basename(projectDir);
  const spec = (id: string, build: SessionSpec['build'], ageMs: number, records: number): SessionSpec => ({
    id,
    project,
    cwd: repo,
    build,
    mtimeAgeMs: ageMs,
    startMs: startFor(nowMs, ageMs, records),
  });
  return [
    spec(QA_SESSION_FRESH, fresh, 6_000, 7),
    spec(QA_SESSION_WAITING, waitingTool, 5 * MINUTE, 3),
    spec(QA_SESSION_QUIET, quiet, QA_QUIET_AGE_MS, 6),
    spec(QA_SESSION_SILENT, silent, 45 * MINUTE, 2),
    {
      ...spec(QA_SESSION_SUBAGENT_ERROR, subagentError, 10 * MINUTE, 7),
      subagents: [
        {
          agentId: 'agentqafailed001',
          meta: { agentType: 'general-purpose', description: 'FIXTURE lint helper' },
          build: subagentErrorHelper,
          mtimeAgeMs: 10 * MINUTE,
          startMs: startFor(nowMs, 10 * MINUTE, 7),
        },
      ],
    },
    spec(QA_SESSION_LONG_LABEL, longLabel, 40 * MINUTE, 5),
  ];
}

export interface QaInstance {
  readonly baseUrl: string;
  readonly port: number;
  /** The temp tree: everything the instance reads and writes is below it. */
  readonly root: string;
  readonly repo: string;
  readonly slug: string;
  /** Session ids by demo letter (A to H) and by the names of the extra sessions. */
  readonly sessions: {
    readonly demo: Readonly<Record<DemoLetter, string>>;
    readonly fresh: string;
    readonly waiting: string;
    readonly quiet: string;
    readonly silent: string;
    readonly subagentError: string;
    readonly longLabel: string;
  };
  /** Number of sessions the instance was fed (14). */
  readonly sessionCount: number;
  /** `GET <path>`; the body is parsed JSON, or the raw text when it is not JSON. */
  getJson(path: string): Promise<{ status: number; body: unknown }>;
  /** Stops the instance, asserts that the port is closed and removes the temp tree. */
  stop(): Promise<void>;
}

export interface QaInstanceOptions {
  /** The clock of the data (default: now). Every age in the data is relative to it. */
  readonly nowMs?: number;
}

function describeCli(result: { code: number; stdout: string; stderr: string }): string {
  return `exit ${String(result.code)}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 600)}`;
}

/** Starts the instance; rejects (after cleaning up) with the step that failed. */
export async function startQaInstance(options: QaInstanceOptions = {}): Promise<QaInstance> {
  const nowMs = options.nowMs ?? Date.now();
  const temp = makeTempDir('qa');
  let started: StartedInstance | undefined;
  let port = 0;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const failures: string[] = [];
    try {
      if (started !== undefined) await started.stop();
      else if (port !== 0) await assertPortClosed(port);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      temp.remove();
    }
    if (existsSync(temp.path)) failures.push(`the temp tree is still there: ${temp.path}`);
    if (failures.length > 0) throw new Error(`startQaInstance stop: ${failures.join('; ')}`);
  };

  const step = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new Error(`qa instance step '${name}' failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  };

  try {
    // `hermeticEnv(root)` points CLAUDE_CONFIG_DIR at `<root>/claude-home`, which is where `buildDemo({ root })` writes the home.
    const root = temp.path;
    const env = hermeticEnv(root);
    const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
    const demo = await step('demo-data', async () => {
      for (const dir of [mcsHome, env['HOME'] ?? join(root, 'home')]) mkdirSync(dir, { recursive: true });
      return buildDemo({ root, nowMs });
    });
    await step('extra-sessions', () => {
      buildClaudeHome(demo.claudeHome, { sessions: extraSessions(demo.projectDir, demo.repo, nowMs), nowMs });
    });

    const wanted = await step('allocate-port', () => allocatePort(QA_PORT_RANGE));
    port = wanted;
    const cli = (args: readonly string[]): ReturnType<typeof runCli> => runCli(args, { mcsHome, env });

    // The demo config is the legacy flat config: its event window is narrower than the runtime accepts and its optional
    // sampler keys (poll, docker, watched processes) are left out of the seed. The Machine and Git panels are on: the Overview
    // views show the panels of the QA machine and of the demo repository.
    const seed = {
      ...Object.fromEntries(
        Object.entries(demo.configJson).filter(
          ([key]) => !['limits', 'poll', 'docker', 'watched_processes'].includes(key),
        ),
      ),
      panels: { machine: true, git: true, logs: false, ledger: true, chain_log: true, attempts: true },
      session_rules: [
        { match: 'STEP=([A-Z]):', label: 'build step {1}' },
        { match: 'FIXTURE QA fresh', label: 'Parser refactor' },
        { match: 'FIXTURE QA waiting', label: 'End-to-end suite' },
        { match: 'FIXTURE QA quiet', label: 'Flaky cache test' },
        { match: 'FIXTURE QA silent', label: 'Search index migration' },
        { match: 'FIXTURE QA subagent', label: 'Release checklist' },
        { match: 'FIXTURE QA long label', label: QA_LONG_LABEL },
      ],
    };
    const seedFile = join(root, 'qa.seed.config.json');
    writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);

    await step('init', async () => {
      const result = await cli([
        'init',
        '--name',
        'QA monitor',
        '--slug',
        QA_SLUG,
        '--repo',
        demo.repo,
        '--port',
        String(wanted),
        '--config',
        seedFile,
      ]);
      if (result.code !== 0) throw new Error(describeCli(result));
    });

    // Three declared work items, configured prices and the trend chart (runtime keys, routed to runtime.json by `configure`).
    const items = [
      { key: 'qa-backend', title: 'Backend build and tests', match: { labels: ['build step A', 'build step B'] } },
      { key: 'qa-deploy', title: 'Deploy to staging', match: { labels: ['build step C'] } },
      { key: 'qa-review', title: 'Release review', match: { labelPrefix: 'build step F' } },
    ];
    await step('configure', async () => {
      const result = await cli([
        'configure',
        '--task',
        QA_SLUG,
        '--repo',
        demo.repo,
        '--set',
        'analytics.usageTrend=true',
        '--set',
        `pricing.models=${JSON.stringify(PRICES)}`,
        '--set',
        `board.items=${JSON.stringify(items)}`,
        '--reason',
        'visual QA fixture',
      ]);
      if (result.code !== 0) throw new Error(describeCli(result));
    });

    started = await step('start', () => startInstance({ repo: demo.repo, slug: QA_SLUG, env }, { port: wanted }));
    const get = async (path: string): Promise<{ status: number; body: unknown }> => {
      const reply = await httpRequest(wanted, path);
      let body: unknown;
      try {
        body = JSON.parse(reply.body);
      } catch {
        body = reply.body;
      }
      return { status: reply.status, body };
    };
    const sessionCount = DEMO_LETTER_LIST.length + 6;
    await step('import-sessions', async () => {
      await waitFor(
        async () => {
          const reply = await get(`${routes.listSessions.path}?limit=100`);
          if (reply.status !== 200) return false;
          const page = routes.listSessions.response.safeParse(reply.body);
          return page.success && page.data.items.length >= sessionCount;
        },
        { what: `${String(sessionCount)} sessions in the session list`, timeoutMs: 90_000, intervalMs: 250 },
      );
    });
    await step('settle', async () => {
      await waitFor(
        async () => {
          const ids = [
            ...DEMO_LETTER_LIST.map((letter) => demo.sessions[letter].sessionId),
            QA_SESSION_FRESH,
            QA_SESSION_WAITING,
            QA_SESSION_QUIET,
            QA_SESSION_SILENT,
            QA_SESSION_SUBAGENT_ERROR,
            QA_SESSION_LONG_LABEL,
          ];
          for (const id of ids) {
            const reply = await get(`/api/v3/sessions/${id}`);
            if (reply.status !== 200) return false;
            if (!isSettled(reply.body)) return false;
          }
          return true;
        },
        { what: 'every transcript file imported (no bytes behind)', timeoutMs: 90_000, intervalMs: 250 },
      );
    });

    const sessionsOf = Object.fromEntries(DEMO_LETTER_LIST.map((letter) => [letter, demo.sessions[letter].sessionId]));
    return {
      baseUrl: `http://127.0.0.1:${String(wanted)}`,
      port: wanted,
      root,
      repo: demo.repo,
      slug: QA_SLUG,
      sessions: {
        demo: sessionsOf as Record<DemoLetter, string>,
        fresh: QA_SESSION_FRESH,
        waiting: QA_SESSION_WAITING,
        quiet: QA_SESSION_QUIET,
        silent: QA_SESSION_SILENT,
        subagentError: QA_SESSION_SUBAGENT_ERROR,
        longLabel: QA_SESSION_LONG_LABEL,
      },
      sessionCount,
      getJson: get,
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

const DEMO_LETTER_LIST: readonly DemoLetter[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** True when every transcript file of a session detail body is imported up to its end. */
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
