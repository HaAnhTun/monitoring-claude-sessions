// The demo builder of 04 11.5: eight synthetic sessions (A-H) with a fake Claude home, a monitored repo with a chain log and a
// ledger, a legacy-compatible config, the numbers a test may expect, and the raw hook payloads for `runHookHandler`.
// It replaces the pre-4.0 Python demo builder (removed in 4.0, ADR 0066). All content is invented and starts with FIXTURE; ids come from a
// seeded counter; timestamps and mtimes derive from `nowMs`; two runs with the same options write identical trees.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { LegacyState, LifecycleState } from '@mcs/shared';
import { isoMsZ } from '@mcs/shared';

import { buildClaudeHome, subagentPath, type SessionSpec } from './claude-home.ts';
import { hookPayload, type HookEventName } from './hooks.ts';
import { writeFixtureMarker } from './temp.ts';
import {
  detUuid,
  projectDirName,
  TranscriptBuilder,
  type JsonRecord,
  type UsageFixture,
  type UsageNumbers,
} from './transcript.ts';
import { buildRepo } from './workspace.ts';

export type DemoLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export const DEMO_LETTERS: readonly DemoLetter[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export interface DemoOptions {
  root: string;
  nowMs: number;
  /** Default: all eight. */
  letters?: DemoLetter[];
  /** Folder name of the monitored repo below `root` (default `FIXTURE-demo`). */
  project?: string;
}

export interface DemoSession {
  sessionId: string;
  transcriptPath: string;
  agents: { agentId: string; transcriptPath: string; workflow: string | null }[];
}

export interface DemoResult {
  /** Fake `CLAUDE_CONFIG_DIR`. */
  claudeHome: string;
  /** Monitored repo root. */
  repo: string;
  /** `<claudeHome>/projects/<sanitized repo>`. */
  projectDir: string;
  /** Legacy-compatible config written under `root`; passed to `$MCS init --config`. */
  configPath: string;
  configJson: Record<string, unknown>;
  /**
   * Every letter has an entry. Letters that were not requested are described but not written: their files do not exist
   * and their `hookPayloads` are empty.
   */
  sessions: Record<DemoLetter, DemoSession>;
  expected: Record<
    DemoLetter,
    {
      usage: { input: number; output: number; cacheCreation: number; cacheRead: number };
      toolCalls: number;
      errors: number;
      legacyState: LegacyState;
      lifecycle: LifecycleState;
      active: boolean;
    }
  >;
  /** Raw stdin payloads (`hookPayload`), consistent with the transcripts, in delivery order. */
  hookPayloads: Record<DemoLetter, { event: HookEventName; payload: Record<string, unknown> }[]>;
}

// ---- the scenarios -------------------------------------------------------------------------------------------------

interface HookItem {
  event: HookEventName;
  payload: Record<string, unknown>;
}

interface Step {
  say: string;
  tool: string;
  input: JsonRecord;
  result: string;
  error?: boolean;
}

interface AgentPlan {
  agentId: string;
  meta: Record<string, unknown>;
  ageMs: number;
  finished: boolean;
  fill(b: TranscriptBuilder): void;
}

interface Plan {
  letter: DemoLetter;
  sessionId: string;
  ageMs: number;
  legacyState: LegacyState;
  lifecycle: LifecycleState;
  active: boolean;
  fillMain(b: TranscriptBuilder, hooks: HookItem[]): void;
  agents: AgentPlan[];
  runId: string | null;
}

interface Ctx {
  seed: string;
  repo: string;
  projectsDir: string;
  projectName: string;
}

const STEP_MS = 1000;
const WORKFLOW_RUN = 'wf_fixture-review';

function usageFor(i: number): UsageFixture {
  return {
    input_tokens: 40 + (i % 7),
    output_tokens: 220 + 10 * (i % 5),
    cache_read_input_tokens: 12_000 * ((i % 4) + 1),
    cache_creation_input_tokens: 900,
  };
}

const FINAL_USAGE: UsageFixture = {
  input_tokens: 20,
  output_tokens: 380,
  cache_read_input_tokens: 140_000,
  cache_creation_input_tokens: 300,
};

const hex17 = (seed: string, key: string): string => detUuid(seed, key).replaceAll('-', '').slice(0, 17);

/** One tool step: the assistant's words and the call share one message id (two records, as the survey shows). */
function runStep(
  b: TranscriptBuilder,
  tag: string,
  index: number,
  step: Step,
  hook: ((event: HookEventName, extra: Record<string, unknown>) => void) | undefined,
): void {
  const messageId = `msg_${tag}_${String(index)}`;
  const usage = usageFor(index);
  b.assistant({ messageId, text: step.say, stop: null, usage });
  const id = b.toolUse(step.tool, step.input, { messageId, usage });
  hook?.('PreToolUse', { tool_name: step.tool, tool_input: step.input, tool_use_id: id });
  b.toolResult(id, { content: step.result, isError: step.error === true });
  if (step.error === true) {
    hook?.('PostToolUseFailure', {
      tool_name: step.tool,
      tool_input: step.input,
      tool_use_id: id,
      error: `Exit code 1\n${step.result}`,
    });
  } else {
    hook?.('PostToolUse', {
      tool_name: step.tool,
      tool_input: step.input,
      tool_use_id: id,
      tool_response: { stdout: step.result, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    });
  }
}

function runPending(
  b: TranscriptBuilder,
  tag: string,
  index: number,
  pending: { say: string; command: string },
  hook: ((event: HookEventName, extra: Record<string, unknown>) => void) | undefined,
): void {
  const messageId = `msg_${tag}_pending`;
  const usage = { ...usageFor(index), cache_read_input_tokens: 90_000 };
  b.assistant({ messageId, text: pending.say, stop: null, usage });
  const input = { command: pending.command };
  const id = b.toolUse('Bash', input, { messageId, usage });
  hook?.('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
}

function bash(command: string, say: string, result: string, error = false): Step {
  return { say, tool: 'Bash', input: { command }, result, ...(error ? { error } : {}) };
}

interface Scenario {
  prompt: string;
  steps: Step[];
  pending?: { say: string; command: string };
  final?: string;
  /** `SessionEnd` closes the session in the hook stream. */
  ends?: boolean;
  /** Steps whose tool hooks are delivered (default all; a long run delivers only the first ones). */
  hookedSteps?: number;
  ageMs: number;
  legacyState: LegacyState;
  lifecycle: LifecycleState;
  active: boolean;
}

const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(0x202e);
const HOSTILE = [
  '<script>alert(1)</script>',
  '[click me](javascript:alert(1))',
  `${ESC}[31mred${ESC}[0m`,
  `${RLO}reversed`,
  '<img src=x onerror=alert(1)>',
  '&lt;b&gt; &amp;',
  'x'.repeat(300),
].join(' ');

const S = 1000;

function scenarioOf(letter: Exclude<DemoLetter, 'F'>): Scenario {
  switch (letter) {
    case 'A':
      return {
        prompt: 'compile the backend and run the unit tests',
        steps: [
          bash('echo FIXTURE compile', 'FIXTURE Starting with a clean compile.', 'FIXTURE BUILD SUCCESS (12.4 s)'),
          bash(
            'echo FIXTURE unit tests',
            'FIXTURE Compiled. Now the unit tests.',
            'FIXTURE Tests run: 214, Failures: 0, Errors: 0, Skipped: 2',
          ),
          bash(
            'echo FIXTURE status',
            'FIXTURE Checking that no generated file is left untracked.',
            'FIXTURE no untracked files',
          ),
        ],
        final: 'FIXTURE Backend compiles and all 214 unit tests pass. No untracked files.',
        ends: true,
        ageMs: 2400 * S,
        legacyState: 'COMPLETED',
        lifecycle: 'completed',
        active: false,
      };
    case 'B':
      return {
        prompt: 'run the integration tests against the staging database',
        steps: [
          bash(
            'echo FIXTURE integration',
            'FIXTURE Running the integration suite.',
            'FIXTURE Tests run: 58, Failures: 3, Errors: 1',
            true,
          ),
          {
            say: 'FIXTURE Three failures in the order repository. Looking at the fixture.',
            tool: 'Read',
            input: { file_path: 'FIXTURE/orders.sql' },
            result: 'FIXTURE -- orders.sql',
          },
          bash(
            'echo FIXTURE rerun',
            'FIXTURE Re-running only that test after fixing the id.',
            'FIXTURE Tests run: 6, Failures: 0, Errors: 0',
          ),
          bash(
            'echo FIXTURE checkout',
            'FIXTURE Now the checkout flow, which still throws.',
            'FIXTURE NullPointerException in CheckoutFlowIT',
            true,
          ),
        ],
        final: 'FIXTURE Stopping here: the checkout test needs a payment stub that does not exist yet.',
        ends: true,
        ageMs: 1900 * S,
        legacyState: 'FAILED',
        lifecycle: 'failed',
        active: false,
      };
    case 'C':
      return {
        prompt: 'deploy the build to staging and run smoke checks',
        steps: [
          bash(
            'echo FIXTURE image',
            'FIXTURE Building the container image.',
            'FIXTURE Successfully tagged shop-api:staging',
          ),
          bash('echo FIXTURE push', 'FIXTURE Pushing it to the registry.', 'FIXTURE digest: sha256:0000 size: 2417'),
        ],
        pending: {
          say: 'FIXTURE Rolling out and waiting for the deployment to become ready.',
          command: 'echo FIXTURE rollout status',
        },
        ageMs: 25 * S,
        legacyState: 'RUNNING',
        lifecycle: 'waiting_tool',
        active: true,
      };
    case 'D':
      return {
        prompt: 'draft the release notes from the merged pull requests',
        steps: [
          bash(
            'echo FIXTURE merges',
            'FIXTURE Listing merged pull requests since the last tag.',
            'FIXTURE Merge PR #212: fix cart rounding',
          ),
        ],
        final: 'FIXTURE Draft release notes written. Waiting for your review before I publish anything.',
        ageMs: 1500 * S,
        legacyState: 'IDLE',
        lifecycle: 'turn_ended',
        active: false,
      };
    case 'E':
      return {
        prompt: 'refactor all service classes to use constructor injection',
        steps: Array.from({ length: 420 }, (_, i) => ({
          say: `FIXTURE Refactoring module ${String(i).padStart(3, '0')}: extracting an interface.`,
          tool: 'Edit',
          input: { file_path: `FIXTURE/module${String(i).padStart(3, '0')}/Service.java` },
          result: `FIXTURE The file has been updated. ${'x'.repeat(400)}`,
        })),
        final: 'FIXTURE Refactor of 420 modules finished; the build is green.',
        hookedSteps: 3,
        ageMs: 300 * S,
        legacyState: 'IDLE',
        lifecycle: 'turn_ended',
        active: false,
      };
    case 'G':
      return {
        prompt: 'sync the translation files with the translation service',
        steps: [bash('echo FIXTURE export', 'FIXTURE Exporting the source strings.', 'FIXTURE Exported 1204 strings')],
        pending: {
          say: 'FIXTURE Uploading and waiting for the service to confirm.',
          command: 'echo FIXTURE upload --wait',
        },
        ageMs: 2000 * S,
        legacyState: 'UNKNOWN',
        lifecycle: 'stale',
        active: false,
      };
    case 'H':
      return {
        prompt: `hostile strings ${HOSTILE}`,
        steps: [
          {
            say: `FIXTURE Showing hostile text: ${HOSTILE}`,
            tool: 'Bash',
            input: { command: `echo FIXTURE ${HOSTILE}` },
            result: `FIXTURE ${HOSTILE}`,
          },
        ],
        final: `FIXTURE Done. ${HOSTILE}`,
        ageMs: 500 * S,
        legacyState: 'IDLE',
        lifecycle: 'turn_ended',
        active: false,
      };
  }
}

function sessionId(c: Ctx, letter: DemoLetter): string {
  return detUuid(c.seed, `session-${letter}`);
}

/** Plan of a letter other than F: one transcript, no agents. */
function planSimple(c: Ctx, letter: Exclude<DemoLetter, 'F'>): Plan {
  const sc = scenarioOf(letter);
  const id = sessionId(c, letter);
  return {
    letter,
    sessionId: id,
    ageMs: sc.ageMs,
    legacyState: sc.legacyState,
    lifecycle: sc.lifecycle,
    active: sc.active,
    agents: [],
    runId: null,
    fillMain: (b, hooks) => {
      const base = { sessionId: id, cwd: c.repo, transcriptPath: join(c.projectsDir, c.projectName, `${id}.jsonl`) };
      const emit = (event: HookEventName, extra: Record<string, unknown> = {}): void => {
        hooks.push({ event, payload: hookPayload(event, base, extra) });
      };
      const prompt = `FIXTURE Run STEP=${letter}: ${sc.prompt}`;
      emit('SessionStart');
      b.user(prompt);
      emit('UserPromptSubmit', { prompt });
      const limit = sc.hookedSteps ?? sc.steps.length;
      sc.steps.forEach((step, i) => {
        runStep(b, letter, i, step, i < limit ? emit : undefined);
      });
      if (sc.pending !== undefined) {
        runPending(b, letter, sc.steps.length, sc.pending, emit);
      }
      if (sc.final !== undefined) {
        b.assistant({ messageId: `msg_${letter}_final`, text: sc.final, stop: 'end_turn', usage: FINAL_USAGE });
        emit('Stop', { last_assistant_message: sc.final });
      }
      if (sc.ends === true) emit('SessionEnd');
    },
  };
}

const REVIEW_AREAS = [
  { key: 'sec', label: 'security review', model: 'sonnet', ageMs: 8 * S, finished: false },
  { key: 'perf', label: 'performance review', model: 'sonnet', ageMs: 120 * S, finished: true },
  { key: 'test', label: 'test coverage review', model: 'haiku', ageMs: 110 * S, finished: true },
  { key: 'docs', label: 'documentation review', model: 'haiku', ageMs: 100 * S, finished: true },
] as const;

/** F: a parent with a workflow of four subagents, one of which is still working. */
function planParent(c: Ctx): Plan {
  const letter: DemoLetter = 'F';
  const id = sessionId(c, letter);
  const agents: AgentPlan[] = REVIEW_AREAS.map((area) => ({
    agentId: hex17(c.seed, `agent-F-${area.key}`),
    meta: {
      agentType: 'workflow-subagent',
      description: `FIXTURE ${area.label}`,
      requestNonInteractive: true,
      requestShape: 'background',
      spawnDepth: 1,
      workflowPhase: 'FIXTURE review phase',
      model: area.model,
    },
    ageMs: area.ageMs,
    finished: area.finished,
    fill: (b) => {
      const tag = `F${area.key}`;
      b.user(`FIXTURE Review: ${area.label}`);
      runStep(
        b,
        tag,
        0,
        bash('echo FIXTURE diff', 'FIXTURE Reading the diff for this area.', 'FIXTURE diff --git a/x b/x (2310 lines)'),
        undefined,
      );
      runStep(
        b,
        tag,
        1,
        {
          say: 'FIXTURE Looking for problems.',
          tool: 'Grep',
          input: { pattern: 'FIXTURE' },
          result: 'FIXTURE src/x: 57: FIXTURE note',
        },
        undefined,
      );
      if (area.finished) {
        b.assistant({
          messageId: `msg_${tag}_final`,
          text: 'FIXTURE Review finished: no blocking issues.',
          stop: 'end_turn',
          usage: FINAL_USAGE,
        });
        b.endTurnTool('StructuredOutput');
      } else {
        runPending(
          b,
          tag,
          2,
          { say: 'FIXTURE Cross-checking findings against the tests.', command: 'echo FIXTURE cross-check' },
          undefined,
        );
      }
    },
  }));
  return {
    letter,
    sessionId: id,
    ageMs: 20 * S,
    legacyState: 'RUNNING',
    lifecycle: 'waiting_agent',
    active: true,
    agents,
    runId: WORKFLOW_RUN,
    fillMain: (b, hooks) => {
      const transcriptPath = join(c.projectsDir, c.projectName, `${id}.jsonl`);
      const base = { sessionId: id, cwd: c.repo, transcriptPath };
      const emit = (event: HookEventName, extra: Record<string, unknown> = {}): void => {
        hooks.push({ event, payload: hookPayload(event, base, extra) });
      };
      const prompt = 'FIXTURE Run STEP=F: review the changes of the last release across four areas';
      emit('SessionStart');
      b.user(prompt);
      emit('UserPromptSubmit', { prompt });
      runStep(
        b,
        'F',
        0,
        bash(
          'echo FIXTURE diff stat',
          'FIXTURE Splitting the review into parallel agents.',
          'FIXTURE 48 files changed',
        ),
        emit,
      );
      const wf = b.toolUse('Workflow', { description: 'FIXTURE parallel review' });
      b.toolResult(wf, {
        content: 'FIXTURE workflow launched',
        toolUseResult: {
          runId: WORKFLOW_RUN,
          taskId: 'task_fixture_workflow',
          taskType: 'local_workflow',
          workflowName: 'parallel-review',
          status: 'async_launched',
          summary: 'FIXTURE parallel review',
          scriptPath: 'FIXTURE/workflow.js',
          transcriptDir: 'FIXTURE/workflows',
        },
      });
      agents.forEach((agent) => {
        emit('SubagentStart', { agent_id: agent.agentId, agent_type: 'workflow-subagent' });
      });
      agents.forEach((agent) => {
        if (!agent.finished) return;
        emit('SubagentStop', {
          agent_id: agent.agentId,
          agent_type: 'workflow-subagent',
          agent_transcript_path: subagentPath(c.projectsDir, c.projectName, id, agent.agentId, WORKFLOW_RUN),
          last_assistant_message: 'FIXTURE review finished',
        });
      });
      runPending(
        b,
        'F',
        1,
        { say: 'FIXTURE Waiting for the review agents to report back.', command: 'echo FIXTURE wait' },
        emit,
      );
    },
  };
}

function planOf(c: Ctx, letter: DemoLetter): Plan {
  return letter === 'F' ? planParent(c) : planSimple(c, letter);
}

// ---- assembling ----------------------------------------------------------------------------------------------------

interface Scratch {
  hooks: HookItem[];
  usage: { input: number; output: number; cacheCreation: number; cacheRead: number };
  toolCalls: number;
  errors: number;
  /** Number of records of the main file and of each agent file (to anchor the last record at its age). */
  mainRecords: number;
  agentRecords: number[];
}

/** Runs a plan against throw-away builders: hooks, record counts and the expected numbers. */
function scratch(plan: Plan, c: Ctx): Scratch {
  const hooks: HookItem[] = [];
  const main = new TranscriptBuilder({ sessionId: plan.sessionId, cwd: c.repo, startMs: 0, stepMs: STEP_MS });
  plan.fillMain(main, hooks);
  const builders = [main];
  const agentRecords: number[] = [];
  for (const agent of plan.agents) {
    const b = new TranscriptBuilder({
      sessionId: plan.sessionId,
      cwd: c.repo,
      startMs: 0,
      stepMs: STEP_MS,
      agentId: agent.agentId,
    });
    agent.fill(b);
    builders.push(b);
    agentRecords.push(b.lines().length);
  }
  const byId = new Map<string, Readonly<UsageNumbers>>();
  for (const b of builders) for (const [id, usage] of b.usageByMessage()) byId.set(id, usage);
  const usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const u of byId.values()) {
    usage.input += u.input_tokens;
    usage.output += u.output_tokens;
    usage.cacheCreation += u.cache_creation_input_tokens;
    usage.cacheRead += u.cache_read_input_tokens;
  }
  return {
    hooks,
    usage,
    toolCalls: builders.reduce((sum, b) => sum + b.toolUseCount(), 0),
    errors: builders.reduce((sum, b) => sum + b.toolErrorCount(), 0),
    mainRecords: main.lines().length,
    agentRecords,
  };
}

function perLetter<T>(fn: (letter: DemoLetter) => T): Record<DemoLetter, T> {
  return { A: fn('A'), B: fn('B'), C: fn('C'), D: fn('D'), E: fn('E'), F: fn('F'), G: fn('G'), H: fn('H') };
}

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `YYYY-MM-DD HH:MM:SS` in UTC, the time format of the demo chain log. */
const logTime = (ms: number): string => `${isoMsZ(ms).slice(0, 10)} ${isoMsZ(ms).slice(11, 19)}`;

function validate(o: DemoOptions): { letters: DemoLetter[]; project: string } {
  if (!Number.isFinite(o.nowMs))
    throw new RangeError(`buildDemo: nowMs must be a finite number, got ${String(o.nowMs)}`);
  const letters = o.letters ?? [...DEMO_LETTERS];
  const seen = new Set<string>();
  for (const letter of letters) {
    if (!DEMO_LETTERS.includes(letter)) throw new RangeError(`buildDemo: '${letter}' is not a demo letter (A-H)`);
    if (seen.has(letter)) throw new RangeError(`buildDemo: letter ${letter} is listed twice`);
    seen.add(letter);
  }
  const project = o.project ?? 'FIXTURE-demo';
  if (!PROJECT_RE.test(project)) throw new RangeError(`buildDemo: project '${project}' is not a safe folder name`);
  return { letters, project };
}

function build(o: DemoOptions): DemoResult {
  const { letters, project } = validate(o);
  const root = resolve(o.root);
  writeFixtureMarker(root);
  const { repo } = buildRepo(join(root, project));
  mkdirSync(join(repo, 'logs'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  const claudeHome = join(root, 'claude-home');
  const projectName = projectDirName(repo);
  const projectsDir = join(claudeHome, 'projects');
  const projectDir = join(projectsDir, projectName);
  const seed = createHash('sha256').update(`${root}|${project}`).digest('hex').slice(0, 16);
  const ctx: Ctx = { seed, repo, projectsDir, projectName };

  const plans = new Map<DemoLetter, Plan>();
  const stats = new Map<DemoLetter, Scratch>();
  for (const letter of DEMO_LETTERS) {
    const plan = planOf(ctx, letter);
    plans.set(letter, plan);
    stats.set(letter, scratch(plan, ctx));
  }
  const planOfLetter = (letter: DemoLetter): Plan => {
    const plan = plans.get(letter);
    if (plan === undefined) throw new Error(`buildDemo: no plan for ${letter}`);
    return plan;
  };
  const statsOf = (letter: DemoLetter): Scratch => {
    const s = stats.get(letter);
    if (s === undefined) throw new Error(`buildDemo: no stats for ${letter}`);
    return s;
  };

  // Files: only the requested letters.
  const specs: SessionSpec[] = letters.map((letter) => {
    const plan = planOfLetter(letter);
    const st = statsOf(letter);
    const startMs = o.nowMs - plan.ageMs - (st.mainRecords - 1) * STEP_MS;
    return {
      id: plan.sessionId,
      project: projectName,
      cwd: repo,
      build: (b) => {
        plan.fillMain(b, []);
      },
      mtimeAgeMs: plan.ageMs,
      startMs,
      subagents: plan.agents.map((agent, i) => ({
        agentId: agent.agentId,
        meta: agent.meta,
        build: (b) => {
          agent.fill(b);
        },
        mtimeAgeMs: agent.ageMs,
        startMs: o.nowMs - agent.ageMs - ((st.agentRecords[i] ?? 1) - 1) * STEP_MS,
      })),
      ...(plan.runId === null
        ? {}
        : { workflow: { runId: plan.runId, finished: false, agents: plan.agents.map((a) => a.agentId) } }),
    };
  });
  buildClaudeHome(claudeHome, { sessions: specs, nowMs: o.nowMs });

  // The repo files the chain-log, ledger and attempts panels read (letters that were requested only).
  const has = (letter: DemoLetter): boolean => letters.includes(letter);
  const startedAt = (letter: DemoLetter): number => {
    const plan = planOfLetter(letter);
    return o.nowMs - plan.ageMs - (statsOf(letter).mainRecords - 1) * STEP_MS - 1000;
  };
  const log: string[] = [];
  if (has('A')) {
    log.push(`${logTime(startedAt('A'))} STEP A START attempt 1 model sonnet effort medium`);
    log.push(`${logTime(o.nowMs - planOfLetter('A').ageMs)} STEP A END exit=0 status=PASS`);
  }
  if (has('B')) {
    log.push(`${logTime(startedAt('B'))} STEP B START attempt 1 model sonnet effort medium`);
    log.push(`${logTime(o.nowMs - planOfLetter('B').ageMs)} STEP B END exit=1 status=FAIL`);
  }
  if (has('C')) log.push(`${logTime(startedAt('C'))} STEP C START attempt 1 model haiku effort low`);
  if (has('F')) log.push(`${logTime(startedAt('F'))} STEP F START attempt 1 model opus effort high`);
  writeFileSync(join(repo, 'logs', 'chain.log'), log.length === 0 ? '' : `${log.join('\n')}\n`);
  const rows: [DemoLetter, string, string][] = [
    ['A', 'PASS', 'FIXTURE compile + unit tests'],
    ['B', 'FAIL', 'FIXTURE checkout blocked'],
    ['C', 'RUNNING', 'FIXTURE deploy to staging'],
    ['D', 'DONE', 'FIXTURE release notes draft'],
    ['F', 'RUNNING', 'FIXTURE parallel review'],
  ];
  const ledger = [
    '| Step | Status | Notes |',
    '|---|---|---|',
    ...rows.filter(([letter]) => has(letter)).map(([letter, status, note]) => `| ${letter} | ${status} | ${note} |`),
  ];
  writeFileSync(join(repo, 'docs', 'status.md'), `${ledger.join('\n')}\n`);

  const configJson: Record<string, unknown> = {
    schema_version: 1,
    title: 'FIXTURE demo monitor',
    repo,
    transcripts_dir: projectDir,
    window_hours: 8,
    session_rules: [{ match: 'STEP=([A-Z]):', label: 'build step {1}' }],
    panels: { machine: true, git: false, logs: false, ledger: true, chain_log: true, attempts: true },
    chain_log: 'logs/chain.log',
    ledger: 'docs/status.md',
    docker: false,
    watched_processes: ['chrome.exe', 'node.exe', 'python.exe', 'java.exe'],
    attempts: {
      label_prefix: 'build step ',
      time_format: '%Y-%m-%d %H:%M:%S',
      start: String.raw`^(?<time>\S+ \S+) STEP (?<part>[A-Z]) START attempt (?<n>[0-9]+) model (?<model>[a-z]+) effort (?<effort>[a-z]+)`,
      end: String.raw`^(?<time>\S+ \S+) STEP (?<part>[A-Z]) END exit=(?<exit>[0-9]+) status=(?<status>[A-Z]+)`,
    },
    limits: { event_window_mb: 0.2 },
    poll: { stale_after_ms: 4000 },
  };
  const configPath = join(root, 'demo.config.json');
  writeFileSync(configPath, `${JSON.stringify(configJson, null, 2)}\n`);

  const sessions = perLetter((letter): DemoSession => {
    const plan = planOfLetter(letter);
    return {
      sessionId: plan.sessionId,
      transcriptPath: join(projectDir, `${plan.sessionId}.jsonl`),
      agents: plan.agents.map((a) => ({
        agentId: a.agentId,
        transcriptPath: subagentPath(projectsDir, projectName, plan.sessionId, a.agentId, plan.runId ?? undefined),
        workflow: plan.runId,
      })),
    };
  });
  const expected = perLetter((letter): DemoResult['expected'][DemoLetter] => {
    const plan = planOfLetter(letter);
    const st = statsOf(letter);
    return {
      usage: st.usage,
      toolCalls: st.toolCalls,
      errors: st.errors,
      legacyState: plan.legacyState,
      lifecycle: plan.lifecycle,
      active: plan.active,
    };
  });
  const hookPayloads = perLetter((letter) => (has(letter) ? statsOf(letter).hooks : []));
  return { claudeHome, repo, projectDir, configPath, configJson, sessions, expected, hookPayloads };
}

/** Builds the demo under `o.root` (see 04 11.5). Rejects with `RangeError` for unusable options. */
export function buildDemo(o: DemoOptions): Promise<DemoResult> {
  try {
    return Promise.resolve(build(o));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
