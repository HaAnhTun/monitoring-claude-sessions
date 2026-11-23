// TC-EVW-03: `events` (ADR 0108): the option table, the kinds, the lines it writes and how it ends when nobody reads.
import type { FollowInput, OpContext } from '@mcs/engine';
import {
  CLI_EVENT_SCHEMA,
  CliEventSchema,
  McsError,
  cliEventSessionOf,
  type CliEvent,
  type StateAssessment,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, eventTextLine, kindsOf, makeCommand } from './events.ts';

const AT = '2026-11-20T10:03:22.450Z';
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const SESSION = '3f2a9c1e-0000-4000-8000-000000000001';

const state: StateAssessment = {
  state: 'waiting_input',
  presence: 'open',
  waitReason: 'permission',
  staleKind: null,
  endReason: null,
  turnOutcome: null,
  basis: 'observed',
  confidence: 'high',
  rule: 'S-6a',
  evidence: [],
  since: AT,
  evaluatedAt: AT,
  legacyState: 'IDLE',
};

const tag = { schema: CLI_EVENT_SCHEMA } as const;
const HELLO: CliEvent = {
  ...tag,
  type: 'hello',
  instanceId: INSTANCE,
  epoch: '0a1b2c3d',
  headSeq: 8840,
  serverTime: AT,
};
const CHANGE: CliEvent = {
  ...tag,
  type: 'change',
  seq: 8841,
  at: AT,
  kind: 'session',
  op: 'upsert',
  sessionId: SESSION,
  session: cliEventSessionOf(state),
};
const DELETE: CliEvent = { ...CHANGE, seq: 8842, op: 'delete', session: null };
const END: CliEvent = { ...tag, type: 'end', headSeq: 8842, count: 2 };

type Typed = Record<string, string | boolean | number>;

interface Call {
  readonly ctx: CommandContext;
  readonly out: string[];
}

/** A context with the line output of the kernel; `closeAfter` lines the reader of the output goes away. */
function callOf(values: Typed, o: { json?: boolean; closeAfter?: number } = {}): Call {
  const out: string[] = [];
  const closed = new AbortController();
  const text = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === 'string' ? v : undefined;
  };
  const ctx: CommandContext = {
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
    json: o.json === true,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
    signal: closed.signal,
    emit: (line) => {
      if (closed.signal.aborted) return false;
      out.push(line);
      if (out.length === o.closeAfter) closed.abort();
      return !closed.signal.aborted;
    },
  };
  return { ctx, out };
}

/** The operation as a script: it yields `events` and records what it was asked and whether it was ended early. */
function fakeOps(events: readonly CliEvent[]) {
  const seen: { inputs: FollowInput[]; yielded: number } = { inputs: [], yielded: 0 };
  return {
    seen,
    ops: {
      // eslint-disable-next-line @typescript-eslint/require-await -- the script has nothing to wait for
      followEvents: async function* (_ctx: OpContext, input: FollowInput): AsyncGenerator<CliEvent, void, void> {
        seen.inputs.push(input);
        for (const event of events) {
          seen.yielded += 1;
          yield event;
        }
      },
    },
  };
}

describe('events command', () => {
  it('is a stream command of the app by default, with --task, --follow, --since and --kind', () => {
    expect(command.name).toBe('events');
    expect(command.defaultScope).toBe('user');
    expect(command.stream).toBe('ndjson');
    expect(Object.keys(command.options)).toEqual(['task', 'follow', 'since', 'kind']);
    expect(command.options['task']).toMatchObject({ required: true });
    expect(command.options['since']).toMatchObject({ integer: [0, 999_999_999_999_999] });
  });

  it('reports sessions by default, every kind for all, and refuses a kind it does not know', () => {
    expect(kindsOf(undefined)).toEqual(['session']);
    expect(kindsOf('all')).toBeNull();
    expect(kindsOf('tool_call, session')).toEqual(['session', 'tool_call']);
    for (const bad of ['sessions', 'session,nope', ',']) {
      expect(() => kindsOf(bad), bad).toThrow(McsError);
    }
  });

  it('writes one caw.event/1 object per line with --json and passes the flags to the operation', async () => {
    const fake = fakeOps([HELLO, CHANGE, DELETE, END]);
    const call = callOf({ task: 'demo', follow: true, since: 8840, kind: 'all' }, { json: true });
    const result = await makeCommand(fake.ops).run(call.ctx);
    expect(result).toEqual({ data: null, text: [] });
    expect(call.out).toHaveLength(4);
    for (const line of call.out) {
      expect(line).not.toContain('\n');
      expect(CliEventSchema.safeParse(JSON.parse(line)).success, line).toBe(true);
    }
    expect(fake.seen.inputs).toEqual([
      { task: 'demo', follow: true, kinds: null, since: 8840, signal: call.ctx.signal },
    ]);
  });

  it('writes text lines without --json: short ids, the state, the rule and the attention', async () => {
    const fake = fakeOps([HELLO, CHANGE, DELETE, END]);
    const call = callOf({ task: 'demo' });
    await makeCommand(fake.ops).run(call.ctx);
    expect(call.out).toEqual([
      '2026-11-20T10:03:22Z hello instance 11111111 epoch 0a1b2c3d head #8840',
      '2026-11-20T10:03:22Z #8841 session 3f2a9c1e waiting_input S-6a needs_you(permission)',
      '2026-11-20T10:03:22Z #8842 session 3f2a9c1e delete',
      'end head #8842 changes 2',
    ]);
    expect(eventTextLine({ ...tag, type: 'reset', reason: 'cursor_too_old', headSeq: 9 })).toBe(
      'reset cursor_too_old head #9',
    );
    expect(fake.seen.inputs[0]).toMatchObject({ follow: false, kinds: ['session'] });
    expect(fake.seen.inputs[0]).not.toHaveProperty('since');
  });

  it('stops asking for changes once the reader of the output went away', async () => {
    const fake = fakeOps([HELLO, CHANGE, DELETE, END]);
    const call = callOf({ task: 'demo', follow: true }, { json: true, closeAfter: 2 });
    await makeCommand(fake.ops).run(call.ctx);
    expect(call.out).toHaveLength(2);
    expect(fake.seen.yielded).toBe(2);
  });
});
