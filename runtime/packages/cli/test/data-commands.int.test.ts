// `sessions list`, `sessions show`, `usage` and `errors` through the real built CLI against a real instance (01 6.3, 6.4, T-CLI-05):
// the table and the lines, the options and their refusals, the exit codes and the `--json` envelopes, what `sessions show` prints
// without `--include-text` (no transcript text at all) and with it (clipped), that untrusted text reaches the terminal escaped, and
// that the same commands print the same lines from the running instance (API) and from its stopped database (DB). All data is
// synthetic (the testkit demo); nothing outside the temp tree is read, and the real `~/.claude` is never touched (`hermeticEnv`).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CliEnvelopeSchema,
  ErrorsResultSchema,
  SessionsListResultSchema,
  SessionsShowResultSchema,
  UsageResultSchema,
  routes,
  type CliEnvelope,
  type SessionSummary,
  type TokenUsage,
  type UsageReport,
} from '@mcs/shared';
import {
  allocatePort,
  buildDemo,
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

import { errorsLines } from '../src/commands/errors.ts';
import { cell, compact, sessionsListLines } from '../src/commands/sessions-list.ts';
import { durationText } from '../src/commands/sessions-show.ts';
import { usageDayLines, usageReportLines, usageToolLines } from '../src/commands/usage.ts';

const temp = makeTempDir('data-commands-int');
const SLUG = 'datacmd';
const LETTERS: readonly DemoLetter[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(0x202e);
const FINAL_A = 'FIXTURE Backend compiles and all 214 unit tests pass. No untracked files.';
const TOOL_A = 'echo FIXTURE unit tests';
const PROMPT_A = 'compile the backend and run the unit tests';

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

interface Live {
  readonly repo: string;
  readonly env: Record<string, string>;
  readonly mcsHome: string;
  readonly demo: DemoResult;
  readonly started: StartedInstance;
  mcs(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

function describeCli(result: { code: number; stdout: string; stderr: string }): string {
  return `exit ${String(result.code)}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 600)}`;
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
  const mcs: Live['mcs'] = (args) => runCli([...args, '--repo', demo.repo], { mcsHome, env });
  const seed = {
    ...Object.fromEntries(
      Object.entries(demo.configJson).filter(
        ([key]) => !['limits', 'poll', 'docker', 'watched_processes'].includes(key),
      ),
    ),
    panels: { machine: false, git: false, logs: false, ledger: false, chain_log: false, attempts: false },
  };
  const seedFile = path.join(root, 'datacmd.seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const port = await allocatePort();
  const init = await mcs([
    'init',
    '--name',
    'Data commands',
    '--slug',
    SLUG,
    '--port',
    String(port),
    '--config',
    seedFile,
  ]);
  if (init.code !== 0) throw new Error(`init ${describeCli(init)}`);
  const configure = await mcs([
    'configure',
    '--task',
    SLUG,
    '--set',
    `pricing.models=${JSON.stringify(PRICES)}`,
    '--reason',
    'data command fixture',
  ]);
  if (configure.code !== 0) throw new Error(`configure ${describeCli(configure)}`);
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
      return reply.status === 200 && page.success && page.data.items.length >= LETTERS.length;
    },
    { what: `${String(LETTERS.length)} sessions in the list`, timeoutMs: 90_000, intervalMs: 250 },
  );
  await waitFor(
    async () => {
      for (const letter of LETTERS) {
        const reply = await get(`/api/v3/sessions/${demo.sessions[letter].sessionId}`);
        if (reply.status !== 200 || !isSettled(reply.body)) return false;
      }
      return true;
    },
    { what: 'every transcript file imported', timeoutMs: 90_000, intervalMs: 250 },
  );
  // the chain log and the lifecycle sweeps add their evidence after the files are imported: wait until the change log stops growing
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
  return { repo: demo.repo, env, mcsHome, demo, started, mcs };
}

function envelopeOf(stdout: string): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(stdout));
}

/** The lines of an output that do not name the reader or the window: those differ between the two modes by design. */
function stable(stdout: string): string {
  return stdout
    .split('\n')
    .filter(
      (line) =>
        !line.includes('(read from') && !/^usage by .*\(window /.test(line) && !line.startsWith('tool calls (window '),
    )
    .join('\n');
}

// Each test spawns several CLI processes at about a second apiece, so the 10 s project default is too short.
describe('the data commands over a real instance', { timeout: 120_000 }, () => {
  let live: Live;
  const idOf = (letter: DemoLetter): string => live.demo.sessions[letter].sessionId;
  beforeAll(async () => {
    live = await startLive();
  }, 240_000);
  afterAll(async () => {
    await killAllTracked();
    temp.remove();
  });

  // The runs below happen while the instance runs (API mode); the last test stops it and repeats them on the database.
  const apiOutputs = new Map<string, string>();
  const COMPARED: readonly (readonly string[])[] = [
    ['sessions', 'list', '--task', SLUG, '--all', '--limit', '200'],
    ['sessions', 'list', '--task', SLUG, '--all', '--state', 'turn_ended,stale'],
    ['sessions', 'show', '--task', SLUG, '--session', 'A', '--events', '4'],
    ['usage', '--task', SLUG],
    ['usage', '--task', SLUG, '--by', 'session', '--since', 'all'],
    ['usage', '--task', SLUG, '--by', 'tool', '--since', 'all'],
    ['errors', '--task', SLUG],
  ];
  const resolved = (args: readonly string[]): string[] => args.map((arg) => (arg === 'A' ? idOf('A') : arg));

  describe('sessions list', () => {
    it('prints the table with the columns id(8), label, state, basis, last activity, tokens and errors', async () => {
      const run = await live.mcs(['sessions', 'list', '--task', SLUG, '--all', '--limit', '200']);
      expect(run.code, run.stderr).toBe(0);
      apiOutputs.set(COMPARED[0]?.join(' ') ?? '', run.stdout);
      const lines = run.stdout.split('\n');
      expect(lines[0]).toMatch(/^ID\s+LABEL\s+STATE\s+BASIS\s+LAST ACTIVITY\s+TOKENS \(IN\/OUT\)\s+ERRORS$/);
      for (const letter of LETTERS) {
        const row = lines.find((line) => line.startsWith(idOf(letter).slice(0, 8)));
        expect(row, letter).toBeDefined();
        expect(row).toContain(`build step ${letter}`);
        expect(row).toMatch(/\b(observed|inferred)\b/);
        expect(row).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
        expect(row).toMatch(/\d+(\.\d+)?[kMG]?\/\d+(\.\d+)?[kMG]?/);
      }
      expect(run.stdout).toContain('8 of 8 sessions (read from the running instance)');
    });

    it('--state, --since, --limit and --all narrow the rows', async () => {
      const turnEnded = await live.mcs([
        'sessions',
        'list',
        '--task',
        SLUG,
        '--state',
        'turn_ended',
        '--since',
        'all',
        '--json',
      ]);
      expect(turnEnded.code, turnEnded.stderr).toBe(0);
      const data = SessionsListResultSchema.parse(envelopeOf(turnEnded.stdout).data);
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items.every((s: SessionSummary) => s.state.state === 'turn_ended')).toBe(true);

      const two = await live.mcs(['sessions', 'list', '--task', SLUG, '--all', '--limit', '2', '--json']);
      const page = SessionsListResultSchema.parse(envelopeOf(two.stdout).data);
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.total).toBe(8);
      const text = await live.mcs(['sessions', 'list', '--task', SLUG, '--all', '--limit', '2']);
      expect(text.stdout).toContain('2 of 8 sessions');
      expect(text.stdout).toContain('more sessions match: raise --limit');

      const none = await live.mcs([
        'sessions',
        'list',
        '--task',
        SLUG,
        '--since',
        '2026-01-01T00:00:00Z',
        '--state',
        'waiting_input',
      ]);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('no sessions match');
    });

    it('refuses what the route refuses, with exit code 2 and the name of the flag', async () => {
      for (const [args, flag] of [
        [['--limit', '0'], '--limit'],
        [['--limit', '201'], '--limit'],
        [['--limit', 'x'], '--limit'],
        [['--state', 'sleeping'], '--state'],
        [['--since', 'yesterday'], '--since'],
      ] as const) {
        const run = await live.mcs(['sessions', 'list', '--task', SLUG, ...args]);
        expect(run.code, args.join(' ')).toBe(2);
        expect(run.stderr, args.join(' ')).toContain(flag);
        expect(run.stdout).toBe('');
      }
      const missing = await live.mcs(['sessions', 'list']);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('--task');
      const json = await live.mcs(['sessions', 'list', '--task', SLUG, '--state', 'sleeping', '--json']);
      expect(json.code).toBe(2);
      const envelope = envelopeOf(json.stdout);
      expect(envelope).toMatchObject({ ok: false, exitCode: 2, data: null, error: { code: 'USAGE' } });
    });

    it('prints one --json envelope whose data is the result', async () => {
      const run = await live.mcs(['sessions', 'list', '--task', SLUG, '--all', '--json']);
      expect(run.code).toBe(0);
      const envelope = envelopeOf(run.stdout);
      expect(envelope).toMatchObject({ ok: true, exitCode: 0, command: 'sessions list', error: null });
      const data = SessionsListResultSchema.parse(envelope.data);
      expect(data).toMatchObject({ task: SLUG, mode: 'api', total: 8 });
      expect(run.stdout.trimStart().startsWith('{')).toBe(true);
      expect(run.stderr).toBe('');
    });

    it('an unknown task is TASK_NOT_FOUND', async () => {
      const run = await live.mcs(['sessions', 'list', '--task', 'nope', '--json']);
      expect(run.code).toBe(1);
      expect(envelopeOf(run.stdout).error?.code).toBe('TASK_NOT_FOUND');
    });
  });

  describe('sessions show', () => {
    it('prints the state with basis and evidence, the tokens, the agents and the newest events', async () => {
      const run = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', idOf('A'), '--events', '4']);
      expect(run.code, run.stderr).toBe(0);
      apiOutputs.set(resolved(COMPARED[2] ?? []).join(' '), run.stdout);
      expect(run.stdout).toContain(`session   ${idOf('A')}`);
      expect(run.stdout).toContain('label     build step A');
      expect(run.stdout).toMatch(/^state\s+\S+ \((observed|inferred), (high|medium|low) confidence, rule \S+\)/m);
      expect(run.stdout).toMatch(/^evidence/m);
      expect(run.stdout).toMatch(/^tokens\s+in \d+, out \d+, cache write \d+, cache read \d+ \(with subagents/m);
      expect(run.stdout).toMatch(/^agents \(1\)/m);
      expect(run.stdout).toMatch(/^events \(newest 4, oldest first/m);
      expect(run.stdout).toMatch(/^\s+TIME\s+TYPE\s+TOOL\s+STATUS\s+MS\s+AGENT$/m);
      expect(run.stdout).toContain('Bash');
      expect(run.stdout).toContain('(read from the running instance)');
    });

    it('reads no transcript text without --include-text: not in the text, not in the JSON', async () => {
      for (const extra of [[], ['--json']]) {
        const run = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', idOf('A'), ...extra]);
        expect(run.code, run.stderr).toBe(0);
        for (const secret of [
          FINAL_A,
          TOOL_A,
          PROMPT_A,
          'FIXTURE Compiled. Now the unit tests.',
          'FIXTURE BUILD SUCCESS',
        ]) {
          expect(run.stdout, `${secret} ${extra.join(' ')}`).not.toContain(secret);
        }
      }
      const json = envelopeOf(
        (await live.mcs(['sessions', 'show', '--task', SLUG, '--session', idOf('A'), '--json'])).stdout,
      );
      const data = SessionsShowResultSchema.parse(json.data);
      expect(data.transcript).toBeNull();
      expect(data.events.every((event) => event.summary === null)).toBe(true);
    });

    it('with --include-text adds the tool summaries and the newest transcript entries, each clipped to 300 characters', async () => {
      const text = await live.mcs([
        'sessions',
        'show',
        '--task',
        SLUG,
        '--session',
        idOf('A'),
        '--include-text',
        '--events',
        '8',
      ]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain(FINAL_A);
      expect(text.stdout).toContain(TOOL_A);
      expect(text.stdout).toMatch(
        /^transcript text of agent main \(newest \d+ of \d+ entries, each clipped to 300 characters\)/m,
      );
      // the long tool results of session E are clipped
      const long = await live.mcs([
        'sessions',
        'show',
        '--task',
        SLUG,
        '--session',
        idOf('E'),
        '--include-text',
        '--events',
        '6',
        '--json',
      ]);
      expect(long.code, long.stderr).toBe(0);
      const data = SessionsShowResultSchema.parse(envelopeOf(long.stdout).data);
      expect(data.transcript?.clipChars).toBe(300);
      expect(data.transcript?.entries.length).toBeGreaterThan(0);
      for (const entry of data.transcript?.entries ?? [])
        expect(Array.from(entry.text).length).toBeLessThanOrEqual(300);
      expect(data.transcript?.entries.some((entry) => entry.text.endsWith('…'))).toBe(true);
      for (const event of data.events) expect(Array.from(event.summary ?? '').length).toBeLessThanOrEqual(300);
    });

    it('shows the escape sequences and bidi controls of a transcript as text, never as controls', async () => {
      const run = await live.mcs([
        'sessions',
        'show',
        '--task',
        SLUG,
        '--session',
        idOf('H'),
        '--include-text',
        '--events',
        '10',
      ]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).not.toContain(ESC);
      expect(run.stdout).not.toContain(RLO);
      expect(run.stdout).toContain('\\u001b');
      expect(run.stdout).toContain('\\u202e');
      const json = await live.mcs([
        'sessions',
        'show',
        '--task',
        SLUG,
        '--session',
        idOf('H'),
        '--include-text',
        '--json',
      ]);
      expect(json.stdout).not.toContain(ESC);
      expect(json.stdout).not.toContain(RLO);
      // still valid JSON that parses back to the real characters
      expect(JSON.stringify(envelopeOf(json.stdout).data)).toContain(RLO);
    });

    it('takes the first characters of an id, and reports an unknown id, a prefix that is too short and an invalid one', async () => {
      const prefix = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', idOf('C').slice(0, 8), '--json']);
      expect(prefix.code, prefix.stderr).toBe(0);
      expect(SessionsShowResultSchema.parse(envelopeOf(prefix.stdout).data).session.id).toBe(idOf('C'));
      const unknown = await live.mcs([
        'sessions',
        'show',
        '--task',
        SLUG,
        '--session',
        'ffffffff-0000-4000-8000-000000000000',
        '--json',
      ]);
      expect(unknown.code).toBe(1);
      expect(envelopeOf(unknown.stdout).error?.code).toBe('NOT_FOUND');
      const ambiguous = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', '0', '--json']);
      expect(ambiguous.code).toBe(2);
      const invalid = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', 'x; DROP', '--json']);
      expect(invalid.code).toBe(2);
      expect(envelopeOf(invalid.stdout).error?.code).toBe('USAGE');
      const events = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', idOf('A'), '--events', '101']);
      expect(events.code).toBe(2);
      const noSession = await live.mcs(['sessions', 'show', '--task', SLUG]);
      expect(noSession.code).toBe(2);
    });

    it('shows the agent tree of a session with a workflow', async () => {
      const run = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', idOf('F')]);
      expect(run.code, run.stderr).toBe(0);
      const agents = run.stdout
        .split('\n')
        .filter((line) => /^\s{2}\s*\S+\s+(main|subagent|workflow_agent)/.test(line));
      expect(agents.length).toBeGreaterThanOrEqual(5);
      expect(agents.some((line) => line.includes('workflow_agent') || line.includes('subagent'))).toBe(true);
    });
  });

  describe('usage', () => {
    it('groups by model by default, with a cost column labelled estimate when prices exist', async () => {
      const run = await live.mcs(['usage', '--task', SLUG]);
      expect(run.code, run.stderr).toBe(0);
      apiOutputs.set(COMPARED[3]?.join(' ') ?? '', run.stdout);
      expect(run.stdout).toMatch(/^usage by model \(window /m);
      expect(run.stdout).toMatch(
        /^MODEL\s+INPUT\s+OUTPUT\s+CACHE WRITE\s+CACHE READ\s+TOTAL\s+SESSIONS\s+COST \(estimate, USD\)\s*(NOTES)?$/m,
      );
      expect(run.stdout).toMatch(/^TOTAL\s/m);
      expect(run.stdout).toMatch(/cost: \d+\.\d+ USD \(estimate; \d+% of the tokens priced\)/);
    });

    it('--by session lists a row per session and --session narrows it', async () => {
      const all = await live.mcs(['usage', '--task', SLUG, '--by', 'session', '--since', 'all']);
      expect(all.code, all.stderr).toBe(0);
      apiOutputs.set(COMPARED[4]?.join(' ') ?? '', all.stdout);
      for (const letter of LETTERS) expect(all.stdout).toContain(idOf(letter).slice(0, 8));
      const one = await live.mcs([
        'usage',
        '--task',
        SLUG,
        '--by',
        'session',
        '--since',
        'all',
        '--session',
        idOf('B'),
        '--json',
      ]);
      const data = UsageResultSchema.parse(envelopeOf(one.stdout).data);
      expect(data.by).toBe('session');
      if (data.by !== 'session') throw new Error('unreachable');
      expect(data.report.rows.map((row) => row.key)).toEqual([idOf('B')]);
    });

    it('--by day and --by tool print their tables', async () => {
      const day = await live.mcs(['usage', '--task', SLUG, '--by', 'day', '--since', '30d']);
      expect(day.code, day.stderr).toBe(0);
      expect(day.stdout).toMatch(/^usage by day \(window /m);
      expect(day.stdout).toMatch(/^DAY\s+INPUT\s+OUTPUT\s+CACHE WRITE\s+CACHE READ\s+MESSAGES\s+NOTES$/m);
      const tool = await live.mcs(['usage', '--task', SLUG, '--by', 'tool', '--since', 'all']);
      expect(tool.code, tool.stderr).toBe(0);
      apiOutputs.set(COMPARED[5]?.join(' ') ?? '', tool.stdout);
      expect(tool.stdout).toMatch(
        /^TOOL\s+MCP SERVER\s+CALLS\s+OK\s+FAILED\s+DENIED\s+INTERRUPTED\s+PENDING\s+FAIL %\s+MEDIAN MS\s+MAX MS$/m,
      );
      expect(tool.stdout).toMatch(/^Bash\s/m);
    });

    it('refuses a bad grouping, a bad session, a bad time and an until without a since', async () => {
      for (const args of [
        ['--by', 'week'],
        ['--session', 'not-an-id'],
        ['--since', 'sometime'],
        ['--until', '2026-10-01T00:00:00Z'],
        ['--since', '7d', '--until', '2026-10-01T00:00:00Z'],
      ]) {
        const run = await live.mcs(['usage', '--task', SLUG, ...args]);
        expect(run.code, args.join(' ')).toBe(2);
        expect(run.stdout).toBe('');
      }
    });
  });

  describe('errors', () => {
    it('lists the recorded errors newest first, or says that there are none', async () => {
      const run = await live.mcs(['errors', '--task', SLUG]);
      expect(run.code, run.stderr).toBe(0);
      apiOutputs.set(COMPARED[6]?.join(' ') ?? '', run.stdout);
      const json = await live.mcs(['errors', '--task', SLUG, '--json']);
      const data = ErrorsResultSchema.parse(envelopeOf(json.stdout).data);
      expect(data.mode).toBe('api');
      const times = data.items.map((item) => item.at);
      expect([...times].sort().reverse()).toEqual(times);
      if (data.items.length === 0) expect(run.stdout).toContain('no errors recorded');
      else expect(run.stdout).toContain(data.items[0]?.code ?? '');
    });

    it('takes --since and --limit and refuses what is out of range', async () => {
      expect((await live.mcs(['errors', '--task', SLUG, '--since', '1h', '--limit', '5'])).code).toBe(0);
      expect((await live.mcs(['errors', '--task', SLUG, '--limit', '0'])).code).toBe(2);
      expect((await live.mcs(['errors', '--task', SLUG, '--limit', '201'])).code).toBe(2);
      expect((await live.mcs(['errors', '--task', SLUG, '--since', 'lately'])).code).toBe(2);
    });
  });

  describe('the same lines twice', () => {
    it('every command prints the same lines when it is run again, which is what the stopped instance is compared with', async () => {
      for (const args of COMPARED) {
        const argv = resolved(args);
        const first = await live.mcs(argv);
        const second = await live.mcs(argv);
        expect(first.code, `${argv.join(' ')}: ${first.stderr}`).toBe(0);
        expect(stable(second.stdout), argv.join(' ')).toBe(stable(first.stdout));
        apiOutputs.set(argv.join(' '), first.stdout);
      }
    });
  });

  describe('the stopped instance', () => {
    it('prints the same lines from the database as it printed from the running instance, and writes nothing', async () => {
      await live.started.stop();
      const workspace = path.join(live.repo, '.claude', 'monitor', 'tasks', SLUG);
      const tree = snapshotTree(workspace);
      for (const args of COMPARED) {
        const argv = resolved(args);
        const fromApi = apiOutputs.get(argv.join(' '));
        expect(fromApi, argv.join(' ')).toBeDefined();
        const run = await live.mcs(argv);
        expect(run.code, `${argv.join(' ')}: ${run.stderr}`).toBe(0);
        expect(run.stdout, argv.join(' ')).toContain('(read from the database (the monitor is not running))');
        expect(stable(run.stdout), argv.join(' ')).toBe(stable(fromApi ?? ''));
      }
      const json = await live.mcs(['sessions', 'list', '--task', SLUG, '--all', '--json']);
      expect(SessionsListResultSchema.parse(envelopeOf(json.stdout).data).mode).toBe('db');
      const text = await live.mcs(['sessions', 'show', '--task', SLUG, '--session', idOf('A'), '--include-text']);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain(FINAL_A);
      expect(snapshotTree(workspace)).toBe(tree);
    });

    it('a task that never ran has no database to read', async () => {
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
      const run = await live.mcs(['sessions', 'list', '--task', 'never', '--json']);
      expect(run.code).toBe(1);
      expect(envelopeOf(run.stdout).error).toMatchObject({ code: 'DB_ERROR' });
      expect(envelopeOf(run.stdout).error?.hint).toContain('mcs start');
    });
  });
});

// ---- rendering of what the instance cannot be made to produce ---------------------------------------------------------------------------

function usageOf(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 100,
    output: 20,
    cacheCreation: 5,
    cacheRead: 1000,
    total: 1125,
    missing: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    turns: 3,
    synthetic: 0,
    unfinalized: 0,
    completeness: 'complete',
    scannedPct: 100,
    lowerBound: false,
    ...over,
  };
}

function reportOf(over: Partial<UsageReport> = {}, usage: Partial<TokenUsage> = {}): UsageReport {
  const row = { key: 'claude-model-x', label: 'claude-model-x', usage: usageOf(usage), cost: null, sessions: 2 };
  return {
    asOfSeq: 1,
    window: { from: null, to: '2026-10-20T12:00:00.000Z' },
    groupBy: 'model',
    totals: { ...row, key: 'total', label: 'Total' },
    rows: [row],
    rowsTruncated: false,
    source: 'x',
    cost: null,
    reportedCost: null,
    ...over,
  };
}

describe('rendering', () => {
  it('has no cost column when no prices exist, and says so', () => {
    const lines = usageReportLines('model', reportOf(), 'db');
    expect(lines.join('\n')).not.toContain('COST');
    expect(lines.join('\n')).toContain('no prices are configured');
  });

  it('labels the cost column estimate when prices exist', () => {
    const cost = { amount: 1.5, currency: 'USD', basis: 'estimate' as const, pricedTokensPct: 100, unpricedModels: [] };
    const report = reportOf({
      cost: {
        currency: 'USD',
        basis: 'estimate',
        source: 'configured_prices',
        amount: 1.5,
        pricedTokensPct: 100,
        pricedModels: ['claude-model-x'],
        unpricedModels: [],
        assumedCacheWriteTier: false,
        note: 'Estimate from prices configured in runtime.json; not a bill.',
      },
      rows: [{ key: 'm', label: 'claude-model-x', usage: usageOf(), cost, sessions: 2 }],
    });
    const text = usageReportLines('model', report, 'api').join('\n');
    expect(text).toContain('COST (estimate, USD)');
    expect(text).toContain('1.50');
    expect(text).toContain('not a bill');
  });

  it('marks a lower bound with >= and a partial count with a note', () => {
    const lower = usageReportLines('model', reportOf({}, { lowerBound: true, completeness: 'partial' }), 'api').join(
      '\n',
    );
    expect(lower).toContain('>=1000');
    expect(lower).toContain('lower bound, partial');
    expect(lower).toContain('>= marks token counts that are a lower bound');
    const exact = usageReportLines('model', reportOf(), 'api').join('\n');
    expect(exact).not.toContain('>=');
  });

  it('prints the day and tool tables, an empty window and a sampled tool report', () => {
    const point = {
      start: '2026-10-19T00:00:00.000Z',
      input: 1,
      output: 2,
      cacheCreation: 3,
      cacheRead: 4,
      messages: 5,
      completeness: 'partial' as const,
    };
    const day = usageDayLines(
      {
        asOfSeq: 1,
        bucket: 'day',
        tzOffsetMinutes: 0,
        window: { from: null, to: '2026-10-20T00:00:00.000Z' },
        points: [point],
        series: null,
      },
      'api',
    ).join('\n');
    expect(day).toContain('2026-10-19');
    expect(day).toContain('partial');
    expect(day).toMatch(/TOTAL\s+1\s+2\s+3\s+4\s+5/);
    expect(
      usageDayLines(
        {
          asOfSeq: 1,
          bucket: 'day',
          tzOffsetMinutes: 0,
          window: { from: null, to: '2026-10-20T00:00:00.000Z' },
          points: [],
          series: null,
        },
        'api',
      ).join('\n'),
    ).toContain('no usage recorded');
    const tools = usageToolLines(
      {
        asOfSeq: 1,
        window: { from: null, to: '2026-10-20T00:00:00.000Z' },
        sampled: true,
        items: [
          {
            toolName: 'Bash',
            mcpServer: null,
            calls: 3,
            succeeded: 2,
            failed: 1,
            denied: 0,
            interrupted: 0,
            pending: 0,
            unknown: 0,
            failurePct: 33.3333,
            medianDurationMs: 10.4,
            maxDurationMs: 20,
          },
        ],
      },
      'api',
    ).join('\n');
    expect(tools).toMatch(/Bash\s+3\s+2\s+1\s+0\s+0\s+0\s+33\.3%\s+10\s+20/);
    expect(tools).toContain('sample');
  });

  it('escapes the control characters of untrusted text and keeps a table row on one line', () => {
    const hostile = `a${ESC}]52;c;ZXZpbA==${String.fromCharCode(7)}b${RLO}c\nd\te`;
    const shown = cell(hostile, 80);
    // not one control character is left in the cell: the whole text is printable (tab and line feed became spaces)
    expect(
      Array.from(shown).every(
        (ch) => (ch.codePointAt(0) ?? 0) > 0x1f && ch !== String.fromCharCode(0x7f) && ch !== RLO,
      ),
    ).toBe(true);
    expect(shown).toContain('\\u001b');
    expect(shown).toContain('\\u202e');
    const summary = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      label: hostile,
      errorCount: 0,
      lastActivityAt: '2026-10-20T11:00:00.000Z',
      state: { state: 'working', basis: 'inferred' },
      usageInclSubagents: usageOf(),
    } as unknown as SessionSummary;
    const lines = sessionsListLines({
      task: 't',
      mode: 'db',
      items: [summary],
      total: 1,
      totalIsLowerBound: false,
      limit: 50,
      hasMore: false,
    });
    expect(lines[1]).toContain('aaaaaaaa');
    expect(lines.slice(0, 2).join('\n')).not.toContain(ESC);
    expect(lines).toHaveLength(4);
  });

  it('prints errors with their place and session, and compacts counts and durations', () => {
    const lines = errorsLines({
      task: 't',
      mode: 'db',
      items: [
        {
          at: '2026-10-20T11:00:00.123Z',
          source: 'spool',
          code: 'SEGMENT_TORN',
          where: 'a.ndjson',
          message: `torn${ESC}[2J`,
          sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
        },
      ],
    });
    expect(lines[0]).toBe('2026-10-20T11:00:00Z  spool  SEGMENT_TORN a.ndjson session aaaaaaaa  torn\\u001b[2J');
    expect(compact(null)).toBe('-');
    expect([0, 999, 1000, 18000, 245000, 2_450_000, 1_200_000_000].map(compact)).toEqual([
      '0',
      '999',
      '1.00k',
      '18.0k',
      '245k',
      '2.45M',
      '1.20G',
    ]);
    expect([900, 59_000, 61_000, 3_725_000, 172_800_000].map(durationText)).toEqual([
      '0s',
      '59s',
      '1m 01s',
      '1h 02m',
      '2d 00h',
    ]);
  });
});
