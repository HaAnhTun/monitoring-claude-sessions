// `verify-completion` through the real built CLI against a real instance (01 6.3, 6.4, T-CLI-08): the verdict line and the evidence
// for a completed run (attempt PASS), a failed one, a run whose turn ended (not terminal) and one that is only inferred; the exit code
// for each `--expect`; the usage and not-found errors; an attempt row without a session; several candidates; that the stopped
// database prints the same lines as the running instance; and that untrusted text reaches the terminal escaped. All data is
// synthetic (the testkit demo); nothing outside the temp tree is read, and the real `~/.claude` is never touched (`hermeticEnv`).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CliEnvelopeSchema,
  VerifyCompletionResultSchema,
  routes,
  type CliEnvelope,
  type VerifyCompletionResult,
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

import { expectationMet, verifyCompletionLines } from '../src/commands/verify-completion.ts';

const temp = makeTempDir('verify-completion-int');
const SLUG = 'verifycmd';
const LETTERS: readonly DemoLetter[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(0x202e);
const BACKSLASH = String.fromCharCode(92);

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

/** `2026-10-20 11:03:04`: the time format of the chain log the demo configures. */
function logTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

async function startLive(): Promise<Live> {
  const root = temp.path;
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? path.join(root, 'mcs-home');
  for (const dir of [mcsHome, env['HOME'] ?? path.join(root, 'home')]) mkdirSync(dir, { recursive: true });
  const nowMs = Date.now() - 60 * 60_000;
  const demo = await buildDemo({ root, nowMs });
  // attempt rows no session answers to: part Q finished once; part M has two attempts and the newest one passed
  appendFileSync(
    path.join(demo.repo, 'logs', 'chain.log'),
    [
      `${logTime(nowMs - 900_000)} STEP Q START attempt 1 model sonnet effort medium`,
      `${logTime(nowMs - 800_000)} STEP Q END exit=0 status=PASS`,
      `${logTime(nowMs - 700_000)} STEP M START attempt 1 model sonnet effort medium`,
      `${logTime(nowMs - 600_000)} STEP M END exit=1 status=FAIL`,
      `${logTime(nowMs - 500_000)} STEP M START attempt 2 model sonnet effort medium`,
      `${logTime(nowMs - 400_000)} STEP M END exit=0 status=PASS`,
      '',
    ].join('\n'),
  );
  const mcs: Live['mcs'] = (args) => runCli([...args, '--repo', demo.repo], { mcsHome, env });
  const seed = {
    ...Object.fromEntries(
      Object.entries(demo.configJson).filter(
        ([key]) => !['limits', 'poll', 'docker', 'watched_processes'].includes(key),
      ),
    ),
    panels: { machine: false, git: false, logs: false, ledger: false, chain_log: false, attempts: true },
  };
  const seedFile = path.join(root, 'verifycmd.seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const port = await allocatePort();
  const init = await mcs([
    'init',
    '--name',
    'Verify completion',
    '--slug',
    SLUG,
    '--port',
    String(port),
    '--config',
    seedFile,
  ]);
  if (init.code !== 0) throw new Error(`init ${describeCli(init)}`);
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

interface Case {
  readonly name: string;
  /** The selector, as the arguments of the command. */
  readonly select: (idOf: (letter: DemoLetter) => string) => string[];
  /** The first line of the output. */
  readonly head: string | RegExp;
  /** The evidence line that must follow. */
  readonly evidence: RegExp;
  /** The exit codes for `--expect completed`, `failed` and `terminal`. */
  readonly exits: readonly [number, number, number];
}

const EXPECTS = ['completed', 'failed', 'terminal'] as const;

const CASES: readonly Case[] = [
  {
    name: 'a completed run (the attempt passed), by label',
    select: () => ['--label', 'build step A'],
    head: /^COMPLETED [(]observed[)]: session [0-9a-f]{8}$/,
    evidence: /^attempts:attempt_row \d{4}-\d\d-\d\dT[\d:]{8}Z chain log: exit=0 status=PASS$/,
    exits: [0, 1, 0],
  },
  {
    name: 'a completed run, by session id',
    select: (idOf) => ['--session', idOf('A')],
    head: /^COMPLETED [(]observed[)]: session [0-9a-f]{8}$/,
    evidence: /^attempts:attempt_row /,
    exits: [0, 1, 0],
  },
  {
    name: 'a completed run, by attempt part',
    select: () => ['--attempt', 'A'],
    head: /^COMPLETED [(]observed[)]: session [0-9a-f]{8}$/,
    evidence: /^attempts:attempt_row /,
    exits: [0, 1, 0],
  },
  {
    name: 'a failed run (the attempt failed)',
    select: () => ['--label', 'build step B'],
    head: /^FAILED [(]observed[)]: session [0-9a-f]{8}$/,
    evidence: /^attempts:attempt_row \S+ chain log: exit=1 status=FAIL$/,
    exits: [1, 0, 0],
  },
  {
    name: 'a run whose turn ended is not terminal, though the fact was observed',
    select: (idOf) => ['--session', idOf('D')],
    head: 'NOT TERMINAL: state=turn_ended (observed, confidence high)',
    evidence: /^transcript:end_turn \S+ assistant ended the turn/,
    exits: [1, 1, 1],
  },
  {
    name: 'a run with an open tool call is only inferred, so it is not terminal',
    select: (idOf) => ['--session', idOf('C')],
    head: 'NOT TERMINAL: state=unknown (inferred, confidence low)',
    evidence: /^transcript:tool_open \S+ tool Bash open for /,
    exits: [1, 1, 1],
  },
  {
    name: 'a quiet run is only inferred, so it is not terminal',
    select: (idOf) => ['--session', idOf('G')],
    head: 'NOT TERMINAL: state=unknown (inferred, confidence low)',
    evidence: /^transcript:tool_open /,
    exits: [1, 1, 1],
  },
  {
    name: 'an attempt row that no session answers to',
    select: () => ['--attempt', 'Q'],
    head: 'COMPLETED (observed): attempt Q',
    evidence: /^attempts:attempt_row \S+ chain log: exit=0 status=PASS$/,
    exits: [0, 1, 0],
  },
  {
    name: 'several attempts of one part: the newest decides',
    select: () => ['--attempt', 'M'],
    head: 'COMPLETED (observed): attempt M (2 candidates, newest decides)',
    evidence: /^attempts:attempt_row \S+ chain log: exit=0 status=PASS$/,
    exits: [0, 1, 0],
  },
];

describe('verify-completion over a real instance', { timeout: 120_000 }, () => {
  let live: Live;
  const idOf = (letter: DemoLetter): string => live.demo.sessions[letter].sessionId;
  const outputs = new Map<string, { code: number; stdout: string }>();
  const verify = (select: readonly string[], ...more: string[]): ReturnType<Live['mcs']> =>
    live.mcs(['verify-completion', '--task', SLUG, ...select, ...more]);
  beforeAll(async () => {
    live = await startLive();
  }, 240_000);
  afterAll(async () => {
    await killAllTracked();
    temp.remove();
  });

  describe('the verdict and the exit code', () => {
    for (const c of CASES) {
      it(c.name, async () => {
        for (const [index, expectation] of EXPECTS.entries()) {
          const run = await verify(c.select(idOf), '--expect', expectation);
          const label = `${c.name} --expect ${expectation}`;
          expect(run.code, `${label}: ${run.stderr}`).toBe(c.exits[index]);
          const lines = run.stdout.trimEnd().split('\n');
          if (typeof c.head === 'string') expect(lines[0], label).toBe(c.head);
          else expect(lines[0], label).toMatch(c.head);
          expect(lines[1], label).toMatch(c.evidence);
          expect(lines, label).toHaveLength(2);
          expect(run.stderr, label).toBe('');
        }
        // --expect completed is the default
        const plain = await verify(c.select(idOf));
        expect(plain.code).toBe(c.exits[0]);
        outputs.set(c.name, { code: plain.code, stdout: plain.stdout });
      });
    }

    it('--json is one envelope: ok exactly when the expectation is met, with the evidence as data', async () => {
      const met = await verify(['--label', 'build step A'], '--json');
      const metEnvelope = envelopeOf(met.stdout);
      expect(met.code).toBe(0);
      expect(metEnvelope).toMatchObject({ ok: true, exitCode: 0, error: null });
      const data = VerifyCompletionResultSchema.parse(metEnvelope.data);
      expect(data).toMatchObject({ task: SLUG, mode: 'api', expect: 'completed', met: true, target: 'build step A' });
      expect(data.completion).toMatchObject({
        outcome: 'completed',
        basis: 'observed',
        resolvedBy: 'label',
        candidates: 1,
      });
      expect(data.completion.sessionId).toBe(idOf('A'));
      const missed = await verify(['--session', idOf('D')], '--json');
      expect(missed.code).toBe(1);
      const missedEnvelope = envelopeOf(missed.stdout);
      expect(missedEnvelope).toMatchObject({ ok: false, exitCode: 1 });
      expect(VerifyCompletionResultSchema.parse(missedEnvelope.data)).toMatchObject({
        met: false,
        completion: { outcome: 'not_terminal', state: 'turn_ended', resolvedBy: 'session_id' },
      });
    });
  });

  describe('a target that cannot be used', () => {
    const failure = async (args: string[]): Promise<{ code: number; error: string }> => {
      const run = await verify(args, '--json');
      return { code: run.code, error: envelopeOf(run.stdout).error?.code ?? 'none' };
    };

    it('a target that is not valid is a usage error, exit 2', async () => {
      expect(await failure(['--session', 'not-a-session-id'])).toEqual({ code: 2, error: 'USAGE' });
      expect(await failure(['--session', idOf('A').slice(0, 8)])).toEqual({ code: 2, error: 'USAGE' });
      expect(await failure(['--label', ''])).toEqual({ code: 2, error: 'USAGE' });
      expect(await failure(['--label', 'x'.repeat(201)])).toEqual({ code: 2, error: 'USAGE' });
      expect(await failure(['--attempt', 'x'.repeat(513)])).toEqual({ code: 2, error: 'USAGE' });
    });

    it('a target that names nothing is NOT_FOUND, exit 1', async () => {
      expect(await failure(['--session', 'aaaaaaaa-0000-4000-8000-00000000ffff'])).toEqual({
        code: 1,
        error: 'NOT_FOUND',
      });
      expect(await failure(['--label', 'no such label'])).toEqual({ code: 1, error: 'NOT_FOUND' });
      expect(await failure(['--attempt', 'Z'])).toEqual({ code: 1, error: 'NOT_FOUND' });
    });

    it('exactly one selector is required, and --expect has three values', async () => {
      expect(await failure([])).toEqual({ code: 2, error: 'USAGE' });
      expect(await failure(['--session', idOf('A'), '--label', 'build step A'])).toEqual({ code: 2, error: 'USAGE' });
      expect(await failure(['--label', 'build step A', '--attempt', 'A'])).toEqual({ code: 2, error: 'USAGE' });
      expect(await failure(['--label', 'build step A', '--expect', 'finished'])).toEqual({ code: 2, error: 'USAGE' });
      const noTask = await live.mcs(['verify-completion', '--label', 'build step A']);
      expect(noTask.code).toBe(2);
    });

    it('prints the reason on stderr in text mode and nothing on stdout, without repeating the label', async () => {
      const run = await verify(['--label', 'no such label']);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/^ERROR: /);
      expect(run.stderr).not.toContain('no such label');
    });
  });

  describe('the stopped instance', () => {
    it('prints the same lines and exit codes from the database as from the running instance, and writes nothing', async () => {
      await live.started.stop();
      const workspace = path.join(live.repo, '.claude', 'monitor', 'tasks', SLUG);
      const tree = snapshotTree(workspace);
      for (const c of CASES) {
        const before = outputs.get(c.name);
        expect(before, c.name).toBeDefined();
        const run = await verify(c.select(idOf));
        expect(run.code, c.name).toBe(before?.code);
        expect(run.stdout, c.name).toBe(before?.stdout);
      }
      const json = await verify(['--label', 'build step A'], '--json');
      expect(VerifyCompletionResultSchema.parse(envelopeOf(json.stdout).data).mode).toBe('db');
      const missing = await verify(['--label', 'no such label'], '--json');
      expect(missing.code).toBe(1);
      expect(envelopeOf(missing.stdout).error?.code).toBe('NOT_FOUND');
      const invalid = await verify(['--session', 'nope'], '--json');
      expect(invalid.code).toBe(2);
      expect(snapshotTree(workspace)).toBe(tree);
    });
  });
});

// ---- rendering of what the instance cannot be made to produce ---------------------------------------------------------------------------

describe('rendering', () => {
  const evidence = (text: string): { kind: string; at: string | null; text: string } => ({
    kind: 'attempts:attempt_row',
    at: '2026-10-20T11:00:00.123Z',
    text,
  });
  const result = (over: Record<string, unknown>, items = [evidence('chain log: exit=0')]): VerifyCompletionResult => ({
    task: 't',
    mode: 'db',
    expect: 'completed',
    met: true,
    target: 'build step A',
    completion: {
      outcome: 'completed',
      state: 'completed',
      basis: 'observed',
      confidence: 'high',
      evidence: items,
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      ruleId: 'C-ATT-ENDED',
      resolvedBy: 'label',
      candidates: 1,
      ...over,
    },
  });

  it('escapes the control characters of untrusted text and keeps an evidence item on one line', () => {
    const hostile = `exit=0${ESC}]52;c;ZXZpbA==${String.fromCharCode(7)}${RLO}x\ny`;
    const lines = verifyCompletionLines(result({}, [evidence(hostile)]));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(ESC);
    expect(lines.join('\n')).not.toContain(RLO);
    expect(lines[1]).toContain(`${BACKSLASH}u001b`);
    expect(lines[1]).toContain(`${BACKSLASH}u202e`);
    const hostileKind = verifyCompletionLines(result({}, [{ ...evidence('x'), kind: `k${ESC}[2J` }]));
    expect(hostileKind[1]).not.toContain(ESC);
  });

  it('names the attempt when no session answers, and says so when several candidates matched', () => {
    expect(verifyCompletionLines(result({ sessionId: null }))[0]).toBe('COMPLETED (observed): attempt build step A');
    expect(verifyCompletionLines(result({ sessionId: null, candidates: 3 }))[0]).toBe(
      'COMPLETED (observed): attempt build step A (3 candidates, newest decides)',
    );
    expect(verifyCompletionLines({ ...result({ sessionId: null }), target: '' })[0]).toBe(
      'COMPLETED (observed): attempt (no part)',
    );
    expect(verifyCompletionLines(result({ outcome: 'failed', state: 'failed' }))[0]).toBe(
      'FAILED (observed): session aaaaaaaa',
    );
    expect(verifyCompletionLines(result({}, []))).toEqual([
      'COMPLETED (observed): session aaaaaaaa',
      'no evidence recorded',
    ]);
  });

  it('meets an expectation only with the outcome it names; terminal accepts completed and failed', () => {
    const table: [CompletionOutcomeName, CompletionExpectation, boolean][] = [
      ['completed', 'completed', true],
      ['failed', 'completed', false],
      ['not_terminal', 'completed', false],
      ['completed', 'failed', false],
      ['failed', 'failed', true],
      ['not_terminal', 'failed', false],
      ['completed', 'terminal', true],
      ['failed', 'terminal', true],
      ['not_terminal', 'terminal', false],
    ];
    for (const [outcome, expectation, met] of table) {
      expect(expectationMet(outcome, expectation), `${outcome} / ${expectation}`).toBe(met);
    }
  });
});

type CompletionOutcomeName = VerifyCompletionResult['completion']['outcome'];
type CompletionExpectation = VerifyCompletionResult['expect'];
