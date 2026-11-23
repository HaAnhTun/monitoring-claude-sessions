// TC-EVW-05, TC-EVW-07: `wait` (ADR 0108): the option table, the flags as the input of the operation, the exit code of every
// outcome, the envelope of a wait that was not met, and the hint after a timeout that the completion check could not decide.
import type { OpContext, WaitInput } from '@mcs/engine';
import { CLI_NAME, CliEnvelopeSchema, McsError, WAIT_UNTILS, type WaitResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { resultEnvelope } from '../render/json.ts';
import { NOT_TERMINAL_HINT, command, makeCommand, waitLines } from './wait.ts';

const SESSION = '3f2a9c1e-0000-4000-8000-000000000001';
const AT = '2026-11-20T10:00:00.000Z';

type Typed = Record<string, string | boolean | number>;

function contextOf(values: Typed): CommandContext {
  const text = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    op: { repo: 'R' } as unknown as OpContext,
    args: {
      positionals: [],
      string: text,
      strings: (name) => {
        const v = text(name);
        return v === undefined ? [] : [v];
      },
      flag: (name) => values[name] === true,
      int: (name) => {
        const v = values[name];
        return typeof v === 'number' ? v : undefined;
      },
    },
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

function resultOf(over: Partial<WaitResult> = {}): WaitResult {
  return {
    outcome: 'met',
    until: 'needs_you',
    sessionId: SESSION,
    state: {
      state: 'waiting_input',
      rule: 'S-6a',
      basis: 'observed',
      confidence: 'high',
      presence: 'open',
      waitReason: 'permission',
      turnOutcome: null,
      since: AT,
    },
    attention: { posture: 'needs_you', reason: 'permission' },
    completion: null,
    waitedMs: 12_400,
    alreadyTrue: false,
    ...over,
  };
}

function fakeOps(result: WaitResult) {
  const inputs: WaitInput[] = [];
  return {
    inputs,
    ops: {
      waitFor: (_ctx: OpContext, input: WaitInput): Promise<WaitResult> => {
        inputs.push(input);
        return Promise.resolve(result);
      },
    },
  };
}

describe('wait command', () => {
  it('acts on the app by default and needs --session and --until; it has no --terminal', () => {
    expect(command.name).toBe('wait');
    expect(command.defaultScope).toBe('user');
    expect(command.stream).toBeUndefined();
    expect(Object.keys(command.options)).toEqual(['task', 'session', 'until', 'timeout', 'hold', 'next', 'appear']);
    expect(command.options['session']).toMatchObject({ required: true });
    expect(command.options['until']).toMatchObject({ required: true, choices: WAIT_UNTILS });
  });

  it('maps every outcome to its exit code, and a wait that was not met to an envelope with data and no error', async () => {
    const codes = { met: 0, timeout: 4, ended: 5, missing: 6 } as const;
    for (const outcome of ['met', 'timeout', 'ended', 'missing'] as const) {
      const fake = fakeOps(resultOf({ outcome }));
      const result = await makeCommand(fake.ops).run(contextOf({ task: 'demo', session: SESSION, until: 'needs_you' }));
      expect(result.exitCode, outcome).toBe(codes[outcome]);
      const envelope = CliEnvelopeSchema.parse(resultEnvelope('wait', result));
      expect(envelope, outcome).toMatchObject({
        ok: outcome === 'met',
        exitCode: codes[outcome],
        error: null,
        data: { outcome, sessionId: SESSION },
      });
    }
  });

  it('turns the flags into the input: the defaults, a duration, seconds, --next', async () => {
    const plain = fakeOps(resultOf());
    await makeCommand(plain.ops).run(contextOf({ task: 'demo', session: SESSION, until: 'needs_you' }));
    expect(plain.inputs[0]).toEqual({
      task: 'demo',
      sessionId: SESSION,
      until: 'needs_you',
      timeoutMs: 30 * 60_000,
      holdMs: 3000,
      next: false,
      appearMs: 30_000,
    });

    const given = fakeOps(resultOf());
    const values = {
      task: 'demo',
      session: SESSION,
      until: 'completed',
      timeout: '2h',
      hold: 10,
      appear: 5,
      next: true,
    };
    await makeCommand(given.ops).run(contextOf(values));
    expect(given.inputs[0]).toMatchObject({ timeoutMs: 7_200_000, holdMs: 10_000, appearMs: 5000, next: true });

    const other = fakeOps(resultOf());
    await makeCommand(other.ops).run(contextOf({ task: 'demo', session: SESSION, until: 'turn_ended', timeout: '0' }));
    expect(other.inputs[0]).toMatchObject({ timeoutMs: 0, holdMs: 0 });
  });

  it('refuses a timeout that is not a duration of at most 7 days', async () => {
    for (const timeout of ['soon', '1.5h', '8d', '-1']) {
      const fake = fakeOps(resultOf());
      const run = makeCommand(fake.ops).run(contextOf({ task: 'demo', session: SESSION, until: 'ended', timeout }));
      const error: unknown = await run.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, timeout).toBeInstanceOf(McsError);
      expect(error, timeout).toMatchObject({ code: 'USAGE' });
      expect(error instanceof McsError ? error.hint : '', timeout).toContain(`${CLI_NAME} wait`);
      expect(fake.inputs).toEqual([]);
    }
  });

  it('prints one line, and a hint after a timeout of completed that nothing observed could prove', () => {
    expect(waitLines(resultOf())).toEqual([
      'met: session 3f2a9c1e reached needs_you, state waiting_input (S-6a), attention needs_you(permission), waited 12s',
    ]);
    expect(waitLines(resultOf({ outcome: 'missing', state: null, attention: null, waitedMs: 30_000 }))).toEqual([
      'missing: no such session 3f2a9c1e, waited 30s',
    ]);
    const unproven = resultOf({
      outcome: 'timeout',
      until: 'completed',
      completion: { outcome: 'not_terminal', ruleId: 'S-8b' },
    });
    const lines = waitLines(unproven);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('timeout: session 3f2a9c1e did not reach completed');
    expect(lines[0]).toContain('completion not_terminal (S-8b)');
    expect(lines[1]).toBe(NOT_TERMINAL_HINT);
    expect(NOT_TERMINAL_HINT).toContain('--until turn_ended');
    expect(NOT_TERMINAL_HINT).toContain(`${CLI_NAME} help hooks install`);
    // a timeout of another condition, or one the check decided, has no hint
    expect(waitLines({ ...unproven, until: 'turn_ended' })).toHaveLength(1);
  });
});
