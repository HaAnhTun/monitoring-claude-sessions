// 01 4.4a, slice S8 done-when: `ingestUntilIdle` over a real context (workspace, database, Claude home of the testkit) with a
// fake ingest service, real timers. Returns idle: true after the fixture is fully imported, and idle: false within
// timeoutMs + 200 ms while a producer keeps appending. The real service of 02 replaces the fake in WP-35's own tests.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { RUNTIME_VERSION } from '@mcs/shared';
import { buildClaudeHome, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { initWorkspace } from '../src/workspace/init.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import {
  STUB_FACTORIES,
  createInstanceRuntime,
  type InstanceRuntime,
  type RuntimeFactories,
} from '../src/runtime/instance-runtime.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');

type Ingest = ReturnType<RuntimeFactories['createIngestService']>;

const contexts: InstanceContext[] = [];
const runtimes: InstanceRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop(Date.now() + 2000);
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

function idleTimeout(pending: unknown): Error {
  return Object.assign(new Error('ingestion did not become idle'), { name: 'IngestIdleTimeoutError', pending });
}

function stats(queued: number): ReturnType<Ingest['stats']> {
  return {
    queued,
    queuedBytes: 0,
    lastCommitAt: null,
    failures: 0,
    spoolBytesBehind: 0,
    transcriptBytesBehind: 0,
    backfillRemainingBytes: 0,
    filesTracked: 1,
  };
}

/** Lines of every transcript below `projects/`: what a real importer would have to read. */
function transcriptLines(claudeHome: string): number {
  let lines = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl'))
        lines += readFileSync(full, 'utf8')
          .split('\n')
          .filter((l) => l !== '').length;
    }
  };
  walk(path.join(claudeHome, 'projects'));
  return lines;
}

/** A service that imports `batch` lines every 5 ms; `append()` is the producer. Idle = nothing left to import. */
class SimulatedIngest {
  pending: number;
  imported = 0;
  private stopped = false;
  readonly writer = {
    submit: () => true,
    onDrain: () => undefined,
    flushNow: () => Promise.resolve(),
    stats: { queued: 0, queuedBytes: 0, lastCommitAt: null, failures: 0 },
  };

  private readonly batch: number;

  constructor(initial: number, batch: number) {
    this.pending = initial;
    this.batch = batch;
  }

  append(lines: number): void {
    this.pending += lines;
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const take = Math.min(this.batch, this.pending);
      this.pending -= take;
      this.imported += take;
      await sleep(5);
    }
  }

  asService(): Ingest {
    return {
      writer: this.writer,
      start: () => {
        void this.pump();
        return Promise.resolve();
      },
      stop: () => {
        this.stopped = true;
        return Promise.resolve();
      },
      untilIdle: async ({ timeoutMs }) => {
        const until = performance.now() + timeoutMs;
        while (this.pending > 0) {
          if (performance.now() >= until) throw idleTimeout(stats(this.pending));
          await sleep(5);
        }
      },
      nudge: () => undefined,
      replay: () => Promise.resolve({ segmentsReset: 0 }),
      stats: () => stats(this.pending),
    };
  }
}

interface Setup {
  readonly ctx: InstanceContext;
  readonly claudeHome: string;
  readonly runtime: InstanceRuntime;
  readonly sim: SimulatedIngest;
  readonly ticks: { sweeper: number; attempts: number };
  readonly onAttemptsTick: { run: () => void };
}

async function setup(o: { batch: number }): Promise<Setup> {
  const root = makeTemp('until-idle').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo' });

  const claudeHome = path.join(root, 'claude-home');
  buildClaudeHome(claudeHome, {
    nowMs: NOW,
    sessions: [
      {
        id: SESSION,
        project: 'demo',
        build: (b) => {
          for (let turn = 0; turn < 40; turn += 1) {
            b.user(`FIXTURE prompt ${String(turn)}`);
            b.toolResult(b.toolUse('Bash', { command: 'echo FIXTURE' }));
            b.assistant({ messageId: `msg_${String(turn)}`, stop: 'end_turn' });
          }
        },
      },
    ],
  });

  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
  });
  contexts.push(ctx);

  const sim = new SimulatedIngest(transcriptLines(ctx.claudeHome), o.batch);
  const ticks = { sweeper: 0, attempts: 0 };
  const onAttemptsTick = { run: (): void => undefined };
  const factories: RuntimeFactories = {
    createIngestService: () => sim.asService(),
    createLifecycleSweeper: () => ({
      start: () => undefined,
      stop: () => Promise.resolve(),
      tickNow: () => {
        ticks.sweeper += 1;
        return Promise.resolve();
      },
    }),
    createDbScheduler: () => ({ start: () => undefined, stop: () => Promise.resolve() }),
    createPanelService: () => ({
      get: () => Promise.reject(new Error('not used')),
      tickAttempts: () => {
        ticks.attempts += 1;
        onAttemptsTick.run();
        return Promise.resolve({ state: 'ok', linesRead: 0, rowsChanged: 0, eventsSubmitted: 0 });
      },
      stats: () => ({}),
      close: () => undefined,
    }),
    publishRouteFile: () => Promise.resolve(),
    createAlertComponents: () => [],
    createUserServices: STUB_FACTORIES.createUserServices,
  };
  const runtime = createInstanceRuntime(ctx, { factories });
  runtimes.push(runtime);
  return { ctx, claudeHome, runtime, sim, ticks, onAttemptsTick };
}

describe('ingestUntilIdle over a real context and a simulated importer (01 4.4a, S8)', () => {
  it('returns idle: true after the fixture is fully imported, with one sweeper tick and one attempts tick', async () => {
    const { runtime, sim, ticks } = await setup({ batch: 20 });
    expect(sim.pending).toBeGreaterThan(100); // the testkit transcript is a real multi-line fixture
    await runtime.start();
    const attemptsAtStart = ticks.attempts;
    const result = await runtime.ingestUntilIdle({ timeoutMs: 10_000 });
    expect(result.idle).toBe(true);
    expect(result.stats.queued).toBe(0);
    expect(sim.pending).toBe(0);
    expect(sim.imported).toBeGreaterThan(100);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    expect(ticks.sweeper).toBe(1);
    expect(ticks.attempts - attemptsAtStart).toBe(1);
  });

  it('returns idle: false within timeoutMs + 200 ms while a producer keeps appending, and never rejects', async () => {
    const { runtime, sim } = await setup({ batch: 20 });
    await runtime.start();
    const control = { producing: true };
    const producer = (async (): Promise<void> => {
      while (control.producing) {
        sim.append(200); // faster than the importer can take
        await sleep(5);
      }
    })();
    const timeoutMs = 400;
    const started = performance.now();
    const result = await runtime.ingestUntilIdle({ timeoutMs });
    const elapsed = performance.now() - started;
    control.producing = false;
    await producer;
    expect(result.idle).toBe(false);
    expect(result.stats.queued).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(timeoutMs + 200);
    expect(result.waitedMs).toBeLessThan(timeoutMs + 200);
  });

  it('keeps waiting when the attempts tick submits more events after the first check', async () => {
    const { runtime, sim, onAttemptsTick, ticks } = await setup({ batch: 50 });
    await runtime.start();
    let injected = false;
    onAttemptsTick.run = (): void => {
      if (!injected) {
        injected = true;
        sim.append(120); // external attempts evidence arrives while the runtime checks
      }
    };
    const result = await runtime.ingestUntilIdle({ timeoutMs: 10_000 });
    expect(injected).toBe(true);
    expect(result.idle).toBe(true);
    expect(sim.pending).toBe(0);
    expect(ticks.sweeper).toBeGreaterThanOrEqual(2); // a second round was needed
  });
});
