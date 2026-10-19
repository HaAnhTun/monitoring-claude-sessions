// The attempts tick over a real workspace, database, transcripts and writer (06 3.10, ADR 0059): the chain log of the demo says
// part A ended with PASS, part B with FAIL and part C is still running. After one tick the session of A is `completed` and the
// session of B is `failed`, both on observed evidence (rule S-1); the session of C is untouched; and a change of the patterns
// takes the evidence away again. Real timers; every directory is a temp directory and nothing leaves this process.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AttemptsPanelSchema, RUNTIME_VERSION } from '@mcs/shared';
import { buildDemo, useTempDirs, type DemoResult } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { createIngestService, type IngestService } from '../src/ingest/service.ts';
import { createAttemptsState, readAttemptsPanel, tickAttempts, type AttemptsTickContext } from '../src/index.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');

interface Stack {
  readonly demo: DemoResult;
  readonly workspaceDir: string;
  /** Opens the instance: a context and a started ingest service, as a (re)start of the process would. */
  open(): Promise<Open>;
}

interface Open {
  readonly ctx: InstanceContext;
  readonly service: IngestService;
  /** The columns of the state of one session. */
  state(sessionId: string): { state: string; basis: string; rule: string } | undefined;
}

const opened: Open[] = [];

afterEach(async () => {
  for (const o of opened.splice(0)) {
    await o.service.stop(Date.now() + 2000).catch(() => undefined);
    o.ctx.db.close();
    await o.ctx.logger.close();
  }
});

async function stack(): Promise<Stack> {
  const root = makeTemp('attempts-lifecycle').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  // the chain log: A ended with PASS, B with FAIL, C still running; the patterns are JavaScript syntax
  const demo = await buildDemo({ root: path.join(root, 'demo'), nowMs: Date.now(), letters: ['A', 'B', 'C'] });
  // the demo config narrows the event window below what the runtime accepts: that key is not the subject of this test
  const seed = Object.fromEntries(Object.entries(demo.configJson).filter(([key]) => key !== 'limits'));
  const seedFile = path.join(root, 'seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const { ws } = await initWorkspace({ repo: demo.repo, name: 'Demo', slug: 'demo', seedConfig: seedFile });
  return {
    demo,
    workspaceDir: ws.dir,
    open: async () => {
      const ctx = await buildInstanceContext({
        instanceDir: ws.dir,
        env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: demo.claudeHome },
        cli: {},
        skillDir: skill,
        runtimeDir: path.join(skill, 'runtime'),
        build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
      });
      const service = createIngestService(ctx);
      const o: Open = {
        ctx,
        service,
        state: (sessionId) =>
          ctx.db.driver
            .prepare<{ state: string; basis: string; rule: string }>(
              'SELECT state, state_basis AS basis, state_rule AS rule FROM sessions WHERE session_uid = :sessionId',
            )
            .get({ sessionId }),
      };
      opened.push(o);
      await service.start();
      await service.untilIdle({ timeoutMs: 30_000 });
      return o;
    },
  };
}

/** The ids of the three demo sessions. */
function ids(demo: DemoResult): { a: string; b: string; c: string } {
  return { a: demo.sessions.A.sessionId, b: demo.sessions.B.sessionId, c: demo.sessions.C.sessionId };
}

describe('the attempts tick and the lifecycle of a session (WP-40)', () => {
  it('makes the session of END PASS completed and the session of END FAIL failed, on observed evidence', async () => {
    const s = await stack();
    const o = await s.open();
    const { a, b, c } = ids(s.demo);
    const before = { a: o.state(a), b: o.state(b), c: o.state(c) };
    expect(before.a?.rule).not.toBe('S-1');
    expect(before.b?.rule).not.toBe('S-1');

    // the context is what the panel service hands to the tick
    const tickContext: AttemptsTickContext = o.ctx;
    const result = await tickAttempts(tickContext, { writer: o.service.writer, state: createAttemptsState() });
    await o.service.writer.flushNow();

    expect(result).toMatchObject({ state: 'ok', linesRead: 5, eventsSubmitted: 2 });
    expect(o.state(a)).toEqual({ state: 'completed', basis: 'observed', rule: 'S-1' });
    expect(o.state(b)).toEqual({ state: 'failed', basis: 'observed', rule: 'S-1' });
    // an open run leaves the session as it was
    expect(o.state(c)).toEqual(before.c);
  });

  it('keeps the evidence across a restart and publishes nothing twice for the rows it already has', async () => {
    const s = await stack();
    const first = await s.open();
    const { a, b } = ids(s.demo);
    await tickAttempts(first.ctx, { writer: first.service.writer, state: createAttemptsState() });
    await first.service.writer.flushNow();
    await first.service.stop(Date.now() + 2000);
    first.ctx.db.close();
    await first.ctx.logger.close();
    opened.splice(opened.indexOf(first), 1);

    const second = await s.open();
    expect(second.state(a)).toMatchObject({ state: 'completed', rule: 'S-1' });
    // a new process knows nothing of what was published: the rows are not read again, the evidence is stored
    const state = createAttemptsState();
    const again = await tickAttempts(second.ctx, { writer: second.service.writer, state });
    await second.service.writer.flushNow();
    expect(again).toMatchObject({ state: 'ok', linesRead: 0, rowsChanged: 0, eventsSubmitted: 0 });
    expect(second.state(a)).toMatchObject({ state: 'completed', basis: 'observed' });
    expect(second.state(b)).toMatchObject({ state: 'failed', basis: 'observed' });
  });

  it('returns the sessions to their derived state when a change of the patterns removes the evidence', async () => {
    const s = await stack();
    const first = await s.open();
    const { a, b, c } = ids(s.demo);
    const derived = { a: first.state(a), b: first.state(b), c: first.state(c) };
    await tickAttempts(first.ctx, { writer: first.service.writer, state: createAttemptsState() });
    await first.service.writer.flushNow();
    expect(first.state(a)?.rule).toBe('S-1');
    await first.service.stop(Date.now() + 2000);
    first.ctx.db.close();
    await first.ctx.logger.close();
    opened.splice(opened.indexOf(first), 1);

    // the owner edits the label prefix: the runs are rebuilt and belong to no session any more
    const configFile = path.join(s.workspaceDir, 'config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { attempts: { label_prefix: string } };
    config.attempts.label_prefix = 'no such step ';
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

    const second = await s.open();
    const result = await tickAttempts(second.ctx, { writer: second.service.writer, state: createAttemptsState() });
    await second.service.writer.flushNow();
    // all five lines are read again; the retraction is published for the two sessions that had evidence
    expect(result).toMatchObject({ state: 'ok', linesRead: 5, eventsSubmitted: 2 });
    expect(second.state(a)).toEqual(derived.a);
    expect(second.state(b)).toEqual(derived.b);
    expect(second.state(c)).toEqual(derived.c);
  });

  it('reads the attempts panel with the usage of the matched sessions', async () => {
    const s = await stack();
    const o = await s.open();
    const { a, c } = ids(s.demo);
    await tickAttempts(o.ctx, { writer: o.service.writer, state: createAttemptsState() });
    await o.service.writer.flushNow();
    const panel = readAttemptsPanel(o.ctx, 30);
    expect(AttemptsPanelSchema.safeParse(panel).success).toBe(true);
    expect(panel.sourceState).toBe('ok');
    expect(panel.rows.map((r) => [r.part, r.state, r.sessionId])).toEqual([
      ['A', 'COMPLETED', a],
      ['B', 'FAILED', ids(s.demo).b],
      ['C', 'RUNNING', c],
    ]);
    expect(panel.rows[0]).toMatchObject({ exit: 0, status: 'PASS', n: 1, model: 'sonnet', effort: 'medium' });
    expect(panel.rows[1]).toMatchObject({ exit: 1, status: 'FAIL' });
    // the usage comes from the session aggregate of the real queries
    const usage = panel.rows[0]?.usage;
    expect(usage?.turns).toBeGreaterThan(0);
    expect(usage?.output).toBe(s.demo.expected.A.usage.output);
    expect(panel.rows.every((r) => r.matchDeltaS !== null && r.matchDeltaS > 0 && r.matchDeltaS < 3)).toBe(true);
  });
});
